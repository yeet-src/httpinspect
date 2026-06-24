// Detail screen: a per-endpoint breakdown for the endpoint the user pressed
// Enter on, plus a scrollable view of the last few raw payloads captured for
// it. Reads `focusKey` (which endpoint), `tick` (the endpoint's fields mutate
// in place, so reading `tick` re-renders), and `bodyScroll` (the payload-view
// scroll offset, driven by j/k in main.jsx). `endpoint()` looks the row up.
import { Box, Text, bold, dim, fg, rgb, idx } from "yeet:tui";
import {
  methodColor, accent, rateOn, grid, label, W_METHOD,
  fmtCount, fmtBytes, fmtAgo, fmtMs, percentile, statusColor,
} from "@/lib/format.js";

// JSON syntax palette + a header-name grey.
const J_KEY = rgb(0x9cdcfe), J_STR = rgb(0xce9178), J_NUM = rgb(0xb5cea8),
  J_LIT = rgb(0x569cd6), J_PUNCT = idx(244), HDR = idx(244);

// Split one JSON line into colored spans (keys, strings, numbers, literals,
// punctuation). Tolerant: runs on raw text too, so truncated bodies still color.
const JSON_TOK = /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|(-?\d+\.?\d*(?:[eE][+-]?\d+)?)|(true|false|null)|([{}\[\],])/g;
function colorJsonLine(line) {
  const spans = [];
  let last = 0, m;
  while ((m = JSON_TOK.exec(line)) !== null) {
    if (m.index > last) spans.push(line.slice(last, m.index));
    if (m[1]) spans.push(fg(J_KEY)(m[1]));
    else if (m[2]) spans.push(fg(J_STR)(m[2]));
    else if (m[3]) spans.push(fg(J_NUM)(m[3]));
    else if (m[4]) spans.push(fg(J_LIT)(m[4]));
    else spans.push(fg(J_PUNCT)(m[5]));
    last = JSON_TOK.lastIndex;
  }
  if (last < line.length) spans.push(line.slice(last));
  return spans.length ? spans : [line];
}

// A body → display lines. JSON gets reformatted (when it parses) and colored;
// anything else is shown raw.
function bodyLines(body) {
  const t = body.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return body.split(/\r?\n/).map((l) => [l]);
  let pretty = body;
  try { pretty = JSON.stringify(JSON.parse(t), null, 2); } catch { /* truncated/invalid: color raw */ }
  return pretty.split(/\r?\n/).map(colorJsonLine);
}

// One captured header line → "Name:" greyed, value plain.
function headerLine(l) {
  const i = l.indexOf(":");
  return i < 0 ? [dim(l)] : [fg(HDR)(l.slice(0, i + 1)), l.slice(i + 1)];
}

// Largest scroll offset the payload view currently allows. The render writes it
// each frame (plain assignment — not a signal) so main.jsx's key handler can
// clamp bodyScroll without re-deriving the line count.
export const scrollState = { max: 0 };

// Components are called `(opts, ...children)` by the JSX runtime, so read the
// value pieces from the rest args — not a `children` prop.
function Field(opts, ...children) {
  return (
    <Box direction="row" height="fit">
      <Text width={12}>{fg(label)(opts.name)}</Text>
      <Text width="1fr" overflow="ellipsis">{children.flat(Infinity)}</Text>
    </Box>
  );
}

/* Status-code tallies as colored "200×120  404×3" spans, busiest first. */
function statusSpans(status) {
  const codes = Object.entries(status).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (codes.length === 0) return dim("— no responses paired yet");
  return codes.flatMap(([code, n], i) =>
    [i ? "  " : "", fg(statusColor(Number(code)))(code), dim(`×${n}`)]);
}

const kindTag = (k) => (k === 1 ? "RESP" : "REQ ");
const dirTag = (d) => (d === 1 ? "in" : "out");

/* Flatten the captured payloads into display lines, each an array of colored
 * spans: a separator, the request/response line (bold) + headers (greyed), a
 * blank, then the JSON-formatted, syntax-colored body. One logical line per
 * Text (no hard-wrap), so the scroll offset is line-exact and long lines clip. */
function buildBodyLines(samples, now, width) {
  const out = [];
  for (const s of samples) {
    const head = `── ${kindTag(s.kind)} ${dirTag(s.dir)} · ${fmtAgo(now - s.ts)} ago `;
    out.push([fg(label)(head + "─".repeat(Math.max(0, width - head.length)))]);
    const sep = s.text.indexOf("\r\n\r\n");
    const headText = sep >= 0 ? s.text.slice(0, sep) : s.text;
    const body = sep >= 0 ? s.text.slice(sep + 4) : "";
    headText.split(/\r?\n/).forEach((l, i) => out.push(i === 0 ? [bold(l)] : headerLine(l)));
    if (body.trim()) {
      out.push([" "]);
      for (const bl of bodyLines(body)) out.push(bl);
    }
    out.push([" "]);
  }
  return out;
}

export default function DetailPanel({ focusKey, tick, endpoint, totals, size, bodyScroll }) {
  return (
    <Box border={{ line: "round", fg: grid }} padding={1} direction="column"
      width="1fr" height="1fr" overflow="hidden">
      {() => {
        tick.get();        // re-render on each state tick (fields mutate in place)
        bodyScroll.get();  // and on scroll
        const r = endpoint(focusKey.get());
        if (!r) { scrollState.max = 0; return <Text>{dim("endpoint no longer tracked — press esc to go back")}</Text>; }
        const now = Date.now();
        const share = totals.reqs ? (r.count / totals.reqs) * 100 : 0;
        const lat = r.lat.length
          ? `p50 ${fmtMs(percentile(r.lat, 50))} · p95 ${fmtMs(percentile(r.lat, 95))} · ` +
            `p99 ${fmtMs(percentile(r.lat, 99))} · max ${fmtMs(Math.max(...r.lat))}`
          : dim("no responses paired yet");

        const { cols, rows } = size.get();
        const width = Math.max(20, cols - 4);
        const lines = buildBodyLines(r.samples, now, width);
        const vis = Math.max(3, rows - 15); // leave room for the stats block + chrome
        scrollState.max = Math.max(0, lines.length - vis);
        const off = Math.min(Math.max(0, bodyScroll.get()), scrollState.max);
        const view = lines.slice(off, off + vis);

        return (
          <Box direction="column" width="1fr" height="1fr">
            <Box direction="row" height="fit">
              <Text width={W_METHOD + 1}>{bold(fg(methodColor(r.method))(r.method))}</Text>
              <Text width="1fr" overflow="ellipsis">{bold(`${r.host}${r.path}`)}</Text>
            </Box>
            <Field name="Requests">
              {bold(fg(accent)(fmtCount(r.count)))}
              {dim(`  ${share.toFixed(1)}%  ·  `)}
              {r.rate > 0 ? fg(rateOn)(`${r.rate}/s`) : dim("0/s")}
              {dim(`  peak ${r.peak}/s`)}
            </Field>
            <Field name="Latency">{lat}</Field>
            <Field name="Status">{statusSpans(r.status)}</Field>
            <Field name="Bytes">{fmtBytes(r.bytes)}{dim(` · first ${fmtAgo(now - r.first)} ago · last ${fmtAgo(now - r.last)} ago`)}</Field>
            <Text> </Text>
            <Text overflow="ellipsis">
              {fg(label)(`Recent payloads (${r.samples.length})  ·  j/k scroll`)}
              {scrollState.max > 0 ? dim(`  ·  ${off}/${scrollState.max}`) : ""}
            </Text>
            <Box direction="column" width="1fr" height="1fr" overflow="hidden">
              {r.samples.length === 0
                ? <Text>{dim("no payloads captured yet")}</Text>
                : view.map((l) => <Text height="1" break="none" overflow="hidden">{l}</Text>)}
            </Box>
          </Box>
        );
      }}
    </Box>
  );
}
