// Shared BPF attach layer. The single src/bpf/httptop.bpf.c unit is compiled to
// bin/probe.bpf.o and loaded here; the feature probe (httptop.js) registers a
// `subscribe(onEvent)` consumer and this module fans every captured event into
// it. All attaches live here.
//
// httptop attaches at the TC layer (TCX, ingress + egress). The loader allows
// only one attach spec per program name per BpfObject, so each network
// namespace is its own BpfObject (hence its own `events` ring buffer) and this
// module owns every ring-buffer subscription, fanning them into the one
// consumer httptop registers.
//
// Coverage, by namespace:
//   • host netns — wildcard by default (the daemon enumerates + attaches every
//     supported interface itself); `--iface a,b` switches to an explicit
//     ifindex list narrowed to those names (which, unlike wildcard, keeps `lo`).
//   • ECS awsvpc task netns — a host daemon's wildcard never reaches these (the
//     task ENI lives inside the task's netns), so we discover running tasks and
//     attach into each task's netns explicitly, reconciling on a timer as tasks
//     start and stop. `--no-tasks` disables this; `--task-loopback` also hooks
//     the in-task `lo` (the 127.0.0.1 leg), best-effort since TCX-on-lo EINVALs
//     on some kernels.
//
// This module imports only yeet:bpf — no `@/` aliases — so it stays runnable on
// its own for the import.meta.main self-test below.
import { BpfObject, RingBuf } from "yeet:bpf";

// ---- args ---------------------------------------------------------------
const wanted = yeet.args.iface
  ? new Set(String(yeet.args.iface).split(",").map((s) => s.trim()).filter(Boolean))
  : null;
const RECONCILE_MS = Math.max(1000, Number(yeet.args.reconcile_ms) || 5000);
const taskLoopback = !!yeet.args.task_loopback;
const noTasks = !!yeet.args.no_tasks;

// ---- low-level helpers --------------------------------------------------
const EXE = { exe: "../bin/probe.bpf.o", base: import.meta.dirname };
const RINGBUF = { kind: "ringbuf", btf_struct: "http_event" };

// Race a graph query against a deadline — a pathological query can otherwise
// wedge the daemon for every run until it restarts.
function withTimeout(p, ms, what) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ]);
}

// Build + start one attachment: both directions of the program against `spec`.
function startAttach(spec) {
  return new BpfObject(EXE)
    .bind("events", RINGBUF)
    .attach("on_ingress", spec)
    .attach("on_egress", spec)
    .start();
}

// ---- host-netns attach spec --------------------------------------------
// No --iface → wildcard (omit `ifindex`); --iface a,b → explicit ifindex list
// resolved from the graph and narrowed to those names.
async function hostSpec() {
  if (!wanted) return { spec: { kind: "tcx" }, label: "all (wildcard)" };
  const { data, errors } = await withTimeout(
    yeet.graph.query(`{ network_interfaces { index name is_up } }`),
    2000, "interface query",
  );
  if (errors) throw new Error(errors[0].message);
  const ifaces = (data.network_interfaces || []).filter((i) => i.is_up && wanted.has(i.name));
  const ifindex = ifaces.map((i) => i.index);
  if (ifindex.length === 0) throw new Error("no matching up interfaces to watch");
  return { spec: { kind: "tcx", ifindex }, label: ifaces.map((i) => i.name).join(",") };
}

// ---- ECS task discovery (host daemon → task netns) ----------------------
// Every container in an awsvpc task shares one netns, and ECS nests each task
// under an `/ecs/<taskId>` cgroup, so one representative pid per <taskId> is
// enough to enter that netns. Grouping by cgroup path is container-runtime
// agnostic (Docker or containerd) as long as ECS uses its default `/ecs`
// cgroup parent.
const TASK_RE = /ecs[/-]([0-9a-f]{32})\b/i;
// Diagnostics from the most recent scan, surfaced by the self-test so a 0-task
// result is debuggable (wrong cgroup layout vs. nothing running) without a code
// round-trip.
let lastScan = { procs: 0, ecsPaths: [], samplePaths: [] };
async function discoverTasks() {
  const { data, errors } = await withTimeout(
    yeet.graph.query(`{ procs { pid cgroups { pathname } } }`),
    3000, "task discovery",
  );
  if (errors) throw new Error(errors[0].message);
  const procs = data.procs || [];
  const byTask = new Map();    // taskId -> first live pid seen in it
  const ecsPaths = new Set();  // cgroup paths mentioning "ecs" (regex debugging)
  const samplePaths = new Set();
  for (const p of procs) {
    for (const c of p.cgroups || []) {
      const path = c.pathname || "";
      if (samplePaths.size < 6) samplePaths.add(path);
      if (/ecs/i.test(path)) ecsPaths.add(path);
      const m = TASK_RE.exec(path);
      if (m && !byTask.has(m[1])) byTask.set(m[1], p.pid);
    }
  }
  lastScan = { procs: procs.length, ecsPaths: [...ecsPaths].slice(0, 6), samplePaths: [...samplePaths] };
  return byTask;
}

// ---- attachment registry + event fan-in ---------------------------------
const active = new Map(); // key -> { control, sub: Promise<subscription> | null }
let consumer = null;      // { onEvent, onError } — registered by httptop.js

function subscribeRing(control) {
  return new RingBuf(control, "events").subscribe(
    (raw) => { if (consumer) consumer.onEvent(raw); },
    (err) => { if (consumer && consumer.onError) consumer.onError(err); },
  );
}

// The one ingestion entry point. httptop.js calls this once; we wire its
// callback to every current ring buffer and to any added later.
export function subscribe(onEvent, onError) {
  consumer = { onEvent, onError };
  for (const entry of active.values()) {
    if (!entry.sub) entry.sub = subscribeRing(entry.control);
  }
}

async function add(key, spec) {
  if (active.has(key)) return;
  const control = await startAttach(spec);
  const entry = { control, sub: null };
  if (consumer) entry.sub = subscribeRing(control);
  active.set(key, entry);
}

async function remove(key) {
  const entry = active.get(key);
  if (!entry) return;
  active.delete(key);
  try { if (entry.sub) (await entry.sub).unsubscribe(); } catch { /* already gone */ }
  try { await entry.control.stop(); } catch { /* already gone */ }
}

// ---- reconcile: keep `active` in sync with the live ECS task set ---------
// Each task is its own BpfObject, so we add new tasks and drop departed ones
// individually — existing attachments are never torn down, so task churn costs
// no events on flows already being watched.
async function reconcile() {
  let tasks;
  try {
    tasks = await discoverTasks();
  } catch (err) {
    return { error: err.message, total: 0, added: [], removed: [], failed: [] };
  }

  const desired = new Map(); // key -> spec
  for (const [taskId, pid] of tasks) {
    desired.set(`task:${taskId}`, { kind: "tcx", ns: { pid } }); // wildcard inside the task netns
    if (taskLoopback) {
      desired.set(`task:${taskId}:lo`, { kind: "tcx", ns: { pid }, ifindex: [1] });
    }
  }

  const added = [], failed = [], removed = [];
  for (const [key, spec] of desired) {
    if (!active.has(key)) {
      try { await add(key, spec); added.push(key); }
      catch (err) { failed.push({ key, msg: err.message }); }
    }
  }
  for (const key of [...active.keys()]) {
    if (key !== "host" && !desired.has(key)) { await remove(key); removed.push(key); }
  }
  return { total: tasks.size, added, removed, failed };
}

// ---- bring up the host attach (fatal on failure), then tasks ------------
let hostLabel = "?";
try {
  const { spec, label } = await hostSpec();
  hostLabel = label;
  await add("host", spec);
} catch (err) {
  console.error(`[httptop] failed to load eBPF: ${err.message}`);
  console.error("[httptop] need CAP_BPF/root and a compiled bin/probe.bpf.o (run `make`).");
  yeet.exit();
}

// The host BpfControl, exported for the import.meta.main self-test below.
export const control = active.get("host").control;

// Discovery + per-task attach runs OFF the critical path: a fire-and-forget
// initial scan plus a timer, so the UI mounts immediately and tasks attach a
// beat later as scans complete. The self-test (below) drives its own scan so it
// can report what it found. Skipped here under import.meta.main to avoid racing
// that.
if (!import.meta.main && !noTasks) {
  reconcile().catch(() => {});
  setInterval(() => reconcile().catch(() => {}), RECONCILE_MS);
}

// What the status bar shows for the watched namespaces.
export const ifaceLabel = hostLabel;

// Standalone correctness probe — `yeet run src/probes/probe.js` aggregates the
// endpoints it sees across the host netns *and* every ECS task netns for a few
// seconds, then prints the counts before exiting. A headless check that the
// kernel filter, the btf_struct envelope, and the task-netns attach all behave
// before any UI exists. Dormant once httptop.js imports this module.
if (import.meta.main) {
  const REQ = /^([A-Z]+) +(\S+) +HTTP\/\d\.\d$/;
  const parse = (bytes) => {
    let t = "";
    for (let i = 0; i < bytes.length; i++) { const c = bytes[i]; if (c === 0) break; t += String.fromCharCode(c); }
    const lines = t.split("\r\n\r\n")[0].split("\r\n");
    const m = REQ.exec(lines[0] || "");
    if (!m) return null;
    let host = "-";
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].indexOf(":");
      if (c > 0 && lines[i].slice(0, c).toLowerCase() === "host") { host = lines[i].slice(c + 1).trim(); break; }
    }
    let path = m[2]; const q = path.indexOf("?"); if (q >= 0) path = path.slice(0, q);
    return { method: m[1], host, path };
  };

  const stats = new Map();
  const seen = new Set();
  let dupes = 0;
  subscribe((raw) => {
    const ev = raw.http_event ?? raw;
    const k = `${ev.family}:${ev.sport}>${ev.dport}#${ev.seq}`;
    if (seen.has(k)) { dupes++; return; }
    seen.add(k);
    const d = ev.data instanceof Uint8Array ? ev.data : Uint8Array.from(Object.values(ev.data));
    const r = parse(d.subarray(0, Number(ev.captured)));
    if (!r) return;
    const key = `${r.method} ${r.host} ${r.path}`;
    stats.set(key, (stats.get(key) || 0) + 1);
  });

  if (!noTasks) {
    const t0 = Date.now();
    const sum = await reconcile();
    const dt = Date.now() - t0;
    if (sum.error) {
      console.log(`[verify] task discovery FAILED after ${dt}ms: ${sum.error}`);
    } else {
      console.log(`[verify] scanned ${lastScan.procs} procs in ${dt}ms — matched ${sum.total} task netns, attached ${sum.added.length}, failed ${sum.failed.length}`);
      sum.failed.forEach((f) => console.log(`[verify]   attach ${f.key} failed: ${f.msg}`));
      if (sum.total === 0) {
        console.log("[verify] no /ecs/<taskId> cgroups matched. cgroup paths mentioning ecs:");
        (lastScan.ecsPaths.length ? lastScan.ecsPaths : ["(none)"]).forEach((p) => console.log(`[verify]   ${p}`));
        console.log("[verify] sample cgroup paths:");
        lastScan.samplePaths.forEach((p) => console.log(`[verify]   ${p}`));
      }
    }
  }

  await new Promise((r) => setTimeout(r, 4500));
  console.log(`[verify] watching ${ifaceLabel} (${active.size} attachment${active.size === 1 ? "" : "s"})`);
  console.log(`[verify] deduped ${dupes} duplicate sightings`);
  console.log("[verify] aggregated endpoints (count desc):");
  [...stats.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, c]) => console.log(`  ${String(c).padStart(3)}  ${k}`));
  for (const key of [...active.keys()]) await remove(key);
  yeet.exit();
}
