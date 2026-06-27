// HTTP ingest + aggregation — the kernel → user data layer. It subscribes to
// the `events` ring buffer on the shared object, parses method + Host + path
// out of each captured request, pairs responses to measure on-the-wire
// latency, and aggregates by endpoint into the reactive signals the
// components read (`rows`, `tick`) plus the `totals` / `endpoint()` lookups.
//
// Unlike the from() idiom (subscription tied to a signal being watched), the
// subscription and tick timers are started eagerly at module load: ingestion
// has to keep running on *both* screens, and the detail screen never reads
// `rows`, so a from() over `rows` would tear the ring buffer down whenever
// detail is open. A daemon-style always-on feed is the right shape here.
import { signal } from "yeet:tui";
import { RingBuf } from "yeet:bpf";
import { control } from "@/probes/probe.js";
import { fmtCount } from "@/lib/format.js";

export const TICK_MS = 400; /* redraw cadence between per-second rate samples */

/* Collapse the query string so `/x?id=1` and `/x?id=2` aggregate together.
 * `--keep-query` keeps them distinct. */
const keepQuery = !!yeet.args.keep_query;

/* Request header used to identify the calling client (a merchant API key, a
 * tenant id, …). Lower-cased for a case-insensitive header match. `--client-header
 * x-tenant-id` overrides; default is the card-auth merchant key. The per-endpoint
 * "by client" breakdown keys on whatever this header carries, falling back to the
 * Host and then "anon". */
const clientHeader = String(yeet.args.client_header || "x-api-key").toLowerCase();

/* Error-rate alert threshold for the status-bar banner: an endpoint trips the
 * banner once enough responses are in and the 4xx+5xx share clears this. */
const ALERT_MIN_RESP = 20;
const ALERT_RATE = 0.15;

/* endpoint key -> { method, host, path, count, prev, rate, peak, bytes,
 * first, last, hist, lat, status, lastMs,
 *   respTotal,  // responses paired (denominator for the error rate)
 *   errs, err4, err5, errPrev, ehist,  // 4xx+5xx accounting, errors/sec history
 *   clients }   // clientId -> { count, errs, status:{} }  (the abuse breakdown) */
const stats = new Map();
export const rows = signal([]);
export const totals = { reqs: 0, bytes: 0, startMs: Date.now() };
export const endpointCount = () => stats.size;
export const endpoint = (key) => stats.get(key) ?? null;
export const keyOf = (r) => `${r.method} ${r.host} ${r.path}`;

/* 4xx+5xx share of an endpoint's paired responses, 0..1 (0 before any land). */
export const errRate = (r) => (r.respTotal ? r.errs / r.respTotal : 0);

/* List sort order. "count" (default, busiest first) or "errors" (worst error
 * rate first) — main.jsx flips it on `e` so the incident floats to the top. */
export const sortMode = signal("count");

/* The worst-offending endpoint for the status-bar banner: the highest error
 * rate above ALERT_RATE once it has enough responses, plus the client driving
 * most of its errors. null when nothing is alarming. */
export function topAlert() {
  let worst = null;
  for (const r of stats.values()) {
    if (r.respTotal < ALERT_MIN_RESP) continue;
    const rate = errRate(r);
    if (rate < ALERT_RATE) continue;
    if (!worst || rate > worst.rate) worst = { row: r, rate };
  }
  if (!worst) return null;
  // Name the client contributing the most errors on that endpoint.
  let topClient = null;
  for (const [id, c] of worst.row.clients) {
    if (c.errs > 0 && (!topClient || c.errs > topClient.errs)) topClient = { id, errs: c.errs };
  }
  return { method: worst.row.method, path: worst.row.path, rate: worst.rate, client: topClient?.id ?? null };
}

/* Bumped every redraw tick. The detail screen reads it so it re-renders as an
 * endpoint's in-place fields (rate, latency, …) change — those mutations don't
 * touch a signal on their own. The list re-renders via `rows` instead. */
export const tick = signal(0);

export const HIST_LEN = 60;  /* req/s samples kept per endpoint (≈1 min) */
export const LAT_LEN = 200;  /* recent response latencies kept (ms) */

/* ---- parsing ------------------------------------------------------ */
function bytesToLatin1(bytes, max) {
  let s = "";
  const n = Math.min(bytes.length, max);
  for (let i = 0; i < n; i++) {
    const c = bytes[i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

const REQ_LINE = /^([A-Z]+) +(\S+) +HTTP\/\d\.\d$/;
const STATUS_LINE = /^HTTP\/\d\.\d (\d{3})/;

/* Status code from a response's first line, or 0 if unparseable. */
function parseStatus(bytes) {
  const m = STATUS_LINE.exec(bytesToLatin1(bytes, bytes.length));
  return m ? Number(m[1]) : 0;
}

/* Parse a request line + Host header out of the captured prefix. Returns
 * { method, host, path } or null if it isn't a well-formed request. */
function parseRequest(bytes) {
  const text = bytesToLatin1(bytes, bytes.length);
  const headEnd = text.indexOf("\r\n\r\n");
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const lines = head.split("\r\n");
  const m = REQ_LINE.exec(lines[0] || "");
  if (!m) return null;

  const method = m[1];
  let target = m[2];

  // One pass over the headers: pull Host (for the endpoint key) and the
  // configured client header (for the per-client breakdown). Both are
  // case-insensitive; we keep scanning until we have what we need.
  let host = null;
  let client = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const c = line.indexOf(":");
    if (c <= 0) continue;
    const name = line.slice(0, c).toLowerCase();
    if (host === null && name === "host") host = line.slice(c + 1).trim();
    else if (client === null && name === clientHeader) client = line.slice(c + 1).trim();
    if (host !== null && client !== null) break;
  }

  // CONNECT / absolute-form targets carry the authority in the target itself.
  if (target.startsWith("http://") || target.startsWith("https://")) {
    const rest = target.slice(target.indexOf("://") + 3);
    const slash = rest.indexOf("/");
    if (!host) host = slash >= 0 ? rest.slice(0, slash) : rest;
    target = slash >= 0 ? rest.slice(slash) : "/";
  }

  let path = target;
  if (!keepQuery) {
    const q = path.indexOf("?");
    if (q >= 0) path = path.slice(0, q);
  }
  return { method, host: host || "-", path, client: client || host || "anon" };
}

/* ---- ingest ------------------------------------------------------- */
/* Dedup loopback double-sightings (a `lo` packet hits both egress & ingress
 * with the same 4-tuple + seq). Keyed flow+seq, pruned by age. */
const seen = new Map(); // dedupKey -> ms
function isDuplicate(ev, now) {
  const k = `${ev.family}:${ev.sport}>${ev.dport}#${ev.seq}`;
  if (seen.has(k)) return true;
  seen.set(k, now);
  return false;
}

/* Pending requests awaiting a response, per flow. A flow is the unordered port
 * pair (a request's reverse-direction response shares it), so each response
 * pairs with the oldest pending request on the same flow (FIFO — HTTP/1.x is
 * request-ordered). Each entry: { ts (kernel ns), key, at (wall ms, for prune) }. */
const pending = new Map(); // flowKey -> [entry, …]
const flowKey = (ev) => `${ev.family}:${Math.min(ev.sport, ev.dport)}-${Math.max(ev.sport, ev.dport)}`;

/* one ring-buffer event (an `http_event`, wrapped under its btf_struct name) */
function onEvent(raw) {
  const ev = raw.http_event ?? raw;
  const now = Date.now();
  if (isDuplicate(ev, now)) return;

  const data = ev.data instanceof Uint8Array
    ? ev.data
    : Uint8Array.from(Object.values(ev.data));

  if (ev.kind === 1) onResponse(ev, data, now);
  else onRequest(ev, data, now);
}

function onRequest(ev, data, now) {
  const req = parseRequest(data.subarray(0, Number(ev.captured)));
  if (!req) return;

  const key = keyOf(req);
  let row = stats.get(key);
  if (!row) {
    row = { ...req, count: 0, prev: 0, rate: 0, peak: 0, bytes: 0,
            first: now, last: now, hist: [], lat: [], status: {}, lastMs: null,
            respTotal: 0, errs: 0, err4: 0, err5: 0, errPrev: 0, ehist: [],
            clients: new Map() };
    stats.set(key, row);
  }
  const len = Number(ev.total_len);
  row.count++;
  row.last = now;
  row.bytes += len;
  totals.reqs++;
  totals.bytes += len;

  // Tally this request against its client now (volume shows immediately); the
  // response's status is attributed to the same client when it's paired below.
  let c = row.clients.get(req.client);
  if (!c) { c = { count: 0, errs: 0, status: {} }; row.clients.set(req.client, c); }
  c.count++;

  // Queue this request so the matching response can measure its latency and so
  // the response's status code lands on the right endpoint and client.
  const f = flowKey(ev);
  let q = pending.get(f);
  if (!q) { q = []; pending.set(f, q); }
  q.push({ ts: Number(ev.ts), key, client: req.client, at: now });
  if (q.length > 64) q.shift(); // cap a flow whose responses we never see
}

function onResponse(ev, data, now) {
  const q = pending.get(flowKey(ev));
  if (!q || q.length === 0) return; // no request seen for this flow
  const { ts: reqTs, key, client } = q.shift();
  if (q.length === 0) pending.delete(flowKey(ev));

  const row = stats.get(key);
  if (!row) return;

  const ms = Math.max(0, (Number(ev.ts) - reqTs) / 1e6); // monotonic ns → ms
  row.lat.push(ms);
  if (row.lat.length > LAT_LEN) row.lat.shift();
  row.lastMs = ms;

  const code = parseStatus(data.subarray(0, Number(ev.captured)));
  if (!code) return;
  row.status[code] = (row.status[code] || 0) + 1;
  row.respTotal++;

  // Error accounting: a 4xx/5xx counts against the endpoint and the client that
  // sent the paired request, so the "by client" breakdown pins who's failing.
  const isErr = code >= 400;
  if (isErr) {
    row.errs++;
    if (code >= 500) row.err5++; else row.err4++;
  }
  const c = row.clients.get(client);
  if (c) {
    c.status[code] = (c.status[code] || 0) + 1;
    if (isErr) c.errs++;
  }
}

/* ---- ticking ------------------------------------------------------ */
/* Re-sort endpoints by count and push to the `rows` signal (the view reads it
 * reactively). Called on every redraw tick. */
function refresh() {
  const data = [...stats.values()];
  if (sortMode.get() === "errors") {
    // Worst error rate first, count as the tiebreaker so quiet endpoints with a
    // lone error don't outrank a busy one that's genuinely on fire.
    data.sort((a, b) => errRate(b) - errRate(a) || b.count - a.count);
  } else {
    data.sort((a, b) => b.count - a.count);
  }
  rows.set(data);
}

/* Per-second: turn the count delta since the last sample into a req/s rate,
 * and prune stale dedup keys. */
function sampleRates() {
  const now = Date.now();
  for (const row of stats.values()) {
    row.rate = row.count - row.prev;
    row.prev = row.count;
    if (row.rate > row.peak) row.peak = row.rate;
    row.hist.push(row.rate);
    if (row.hist.length > HIST_LEN) row.hist.shift();

    // Errors/sec this window, kept as a sibling history for the detail sparkline.
    const erate = row.errs - row.errPrev;
    row.errPrev = row.errs;
    row.ehist.push(erate);
    if (row.ehist.length > HIST_LEN) row.ehist.shift();
  }
  for (const [k, t] of seen) if (now - t > 4000) seen.delete(k);

  // Drop pending requests whose response never arrived (>10s) so unmatched
  // flows don't leak; an empty queue is removed entirely.
  for (const [f, q] of pending) {
    while (q.length && now - q[0].at > 10000) q.shift();
    if (q.length === 0) pending.delete(f);
  }

  refresh();
  tick.set(tick.get() + 1); // wake the detail screen (see `tick`)

  // Reflect live totals in the terminal title. `tty` is only defined in TTY
  // mode (absent when piped/redirected), so guard it.
  if (typeof tty !== "undefined") {
    tty.title(`httpinspect · ${fmtCount(totals.reqs)} reqs · ${stats.size} endpoints`);
  }
}

// Start the feed. The ring buffer is single-consumer and ingestion is
// always-on (see the module header), so wire it up at load time.
new RingBuf(control, "events").subscribe(
  onEvent,
  (err) => console.error("[httptop] ringbuf error:", err.message),
);
setInterval(sampleRates, 1000);
setInterval(refresh, TICK_MS); // snappier redraw between rate ticks
