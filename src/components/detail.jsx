// Detail screen: a per-endpoint breakdown for the endpoint the user pressed
// Enter on, plus an accordion of the last few captured payloads — each a
// collapsible row, the selected one expanded to its full headers + JSON body.
// Reads `focusKey` (which endpoint), `tick` (the endpoint's fields mutate in
// place, so reading `tick` re-renders), and `detailSel` (the accordion cursor,
// moved by ↑/↓ in main.jsx). `endpoint()` looks the row up.
import { Box, Text, bold, fg, rgb } from "yeet:tui";
import {
  methodColor, accent, rateOn, grid, label, muted, W_METHOD,
  fmtCount, fmtBytes, fmtAgo, fmtMs, percentile, statusColor,
} from "@/lib/format.js";

// Vibrant JSON syntax palette (keys cyan, strings yellow, numbers purple,
// literals pink; punctuation uses the shared muted indigo).
const J_KEY = rgb(0x8be9fd), J_STR = rgb(0xf1fa8c), J_NUM = rgb(0xbd93f9), J_LIT = rgb(0xff79c6);

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
    else spans.push(fg(muted)(m[5]));
    last = JSON_TOK.lastIndex;
  }
  if (last < line.length) spans.push(line.slice(last));
  return spans.length ? spans : [line];
}

// Hard-wrap a string into <=width chunks so long values don't clip off-screen.
function wrapTo(line, width) {
  if (line.length <= width) return [line];
  const out = [];
  for (let i = 0; i < line.length; i += width) out.push(line.slice(i, i + width));
  return out;
}

// A body → display lines, wrapped to `width` and colored. JSON is reformatted
// (when it parses) and syntax-colored; anything else is shown raw. Coloring a
// wrapped chunk is best-effort — a value split mid-string just renders plain.
function bodyLines(body, width) {
  const t = body.trim();
  let src = body;
  if (t.startsWith("{") || t.startsWith("[")) {
    try { src = JSON.stringify(JSON.parse(t), null, 2); } catch { /* truncated: color raw */ }
  }
  const out = [];
  for (const line of src.split(/\r?\n/)) for (const c of wrapTo(line, width)) out.push(colorJsonLine(c));
  return out;
}

// One captured header line → "Name:" in pink, value plain.
function headerLine(l) {
  const i = l.indexOf(":");
  return i < 0 ? [fg(muted)(l)] : [fg(label)(l.slice(0, i + 1)), l.slice(i + 1)];
}

// Max scroll offset the payload view allows, published each render so main.jsx
// can clamp PgUp/PgDn line-scrolling without re-deriving the line count.
export const detailView = { max: 0 };

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
  if (codes.length === 0) return fg(muted)("— no responses paired yet");
  return codes.flatMap(([code, n], i) =>
    [i ? "  " : "", bold(fg(statusColor(Number(code)))(code)), fg(muted)(`×${n}`)]);
}

const kindTag = (k) => (k === 1 ? "RESP" : "REQ ");
const dirTag = (d) => (d === 1 ? "in" : "out");

/* The payload accordion as display lines (each an array of colored spans).
 * Every captured payload is a one-line collapsible header (▸) showing its
 * kind/age and a snippet of the request/response line; the selected one (▾)
 * expands to its full headers + JSON-formatted, syntax-colored body, indented. */
function accordionLines(samples, sel, now, width) {
  const lines = [];
  samples.forEach((s, i) => {
    const open = i === sel;
    const head = `${open ? "▾" : "▸"} ${kindTag(s.kind)} ${dirTag(s.dir)} · ${fmtAgo(now - s.ts)} ago  `;
    const snippet = (s.text.split(/\r?\n/)[0] || "").slice(0, Math.max(0, width - head.length));
    lines.push(open
      ? [bold(fg(accent)(head)), bold(snippet)]
      : [fg(muted)(head), fg(muted)(snippet)]);
    if (!open) return;
    const sep = s.text.indexOf("\r\n\r\n");
    const headText = sep >= 0 ? s.text.slice(0, sep) : s.text;
    const body = sep >= 0 ? s.text.slice(sep + 4) : "";
    const W = Math.max(8, width - 2);
    const indent = (sp) => [fg(muted)("  "), ...sp];
    lines.push([" "]);
    headText.split(/\r?\n/).forEach((l, j) =>
      wrapTo(l, W).forEach((c, k) =>
        lines.push(indent(j === 0 ? [bold(c)] : (k === 0 ? headerLine(c) : [c])))));
    if (body.trim()) {
      lines.push([" "]);
      for (const bl of bodyLines(body, W)) lines.push(indent(bl));
    }
    lines.push([" "]);
  });
  return lines;
}

export default function DetailPanel({ focusKey, tick, endpoint, totals, size, detailSel, detailScroll }) {
  return (
    <Box border={{ line: "round", fg: grid }} padding={1} direction="column"
      width="1fr" height="1fr" overflow="hidden">
      {() => {
        tick.get();         // re-render on each state tick (fields mutate in place)
        detailSel.get();    // and when the accordion cursor moves
        detailScroll.get(); // and when the open payload is line-scrolled
        const r = endpoint(focusKey.get());
        if (!r) return <Text>{fg(muted)("endpoint no longer tracked — press esc to go back")}</Text>;
        const now = Date.now();
        const share = totals.reqs ? (r.count / totals.reqs) * 100 : 0;
        const lat = r.lat.length
          ? `p50 ${fmtMs(percentile(r.lat, 50))} · p95 ${fmtMs(percentile(r.lat, 95))} · ` +
            `p99 ${fmtMs(percentile(r.lat, 99))} · max ${fmtMs(Math.max(...r.lat))}`
          : fg(muted)("no responses paired yet");

        const { cols, rows } = size.get();
        const width = Math.max(20, cols - 4);
        const sel = Math.min(Math.max(0, detailSel.get()), Math.max(0, r.samples.length - 1));
        const lines = accordionLines(r.samples, sel, now, width);
        const vis = Math.max(3, rows - 15); // leave room for the stats block + chrome
        detailView.max = Math.max(0, lines.length - vis);
        const off = Math.min(Math.max(0, detailScroll.get()), detailView.max);
        const view = lines.slice(off, off + vis);

        return (
          <Box direction="column" width="1fr" height="1fr">
            <Box direction="row" height="fit">
              <Text width={W_METHOD + 1}>{bold(fg(methodColor(r.method))(r.method))}</Text>
              <Text width="1fr" overflow="ellipsis">{bold(fg(accent)(`${r.host}${r.path}`))}</Text>
            </Box>
            <Field name="Requests">
              {bold(fg(accent)(fmtCount(r.count)))}
              {fg(muted)(`  ${share.toFixed(1)}%  ·  `)}
              {r.rate > 0 ? bold(fg(rateOn)(`${r.rate}/s`)) : fg(muted)("0/s")}
              {fg(muted)(`  peak ${r.peak}/s`)}
            </Field>
            <Field name="Latency">{lat}</Field>
            <Field name="Status">{statusSpans(r.status)}</Field>
            <Field name="Bytes">{bold(fg(label)(fmtBytes(r.bytes)))}{fg(muted)(` · first ${fmtAgo(now - r.first)} ago · last ${fmtAgo(now - r.last)} ago`)}</Field>
            <Text> </Text>
            <Text overflow="ellipsis">
              {fg(label)(`Payloads (${r.samples.length})`)}
              {r.samples.length ? fg(muted)(`  ·  ↑/↓ payload · PgUp/Dn scroll  ·  ${sel + 1}/${r.samples.length}`) : ""}
            </Text>
            <Box direction="column" width="1fr" height="1fr" overflow="hidden">
              {r.samples.length === 0
                ? <Text>{fg(muted)("no payloads captured yet")}</Text>
                : view.map((l) => <Text height="1" break="none" overflow="hidden">{l}</Text>)}
            </Box>
          </Box>
        );
      }}
    </Box>
  );
}
