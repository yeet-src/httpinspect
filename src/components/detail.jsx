// Detail screen: a per-endpoint breakdown plus a three-pane transaction
// inspector — a list of captured transactions (left), and the selected one's
// headers (top-right) and body (bottom-right) in their own scrollable panes.
// `<`/`>` flip between the request (in) and response (out); `tab` moves focus
// between the headers/body panes; PgUp/Dn scroll the focused pane. Reads
// `focusKey`, `tick`, and the nav signals (`txnSel`, `txnDir`, `pane`, `scroll`).
import { Box, Text, bold, fg, rgb } from "yeet:tui";
import {
  methodColor, accent, rateOn, grid, label, muted, W_METHOD,
  fmtCount, fmtBytes, fmtAgo, fmtMs, percentile, statusColor,
} from "@/lib/format.js";

// Vibrant JSON syntax palette (keys cyan, strings yellow, numbers purple,
// literals pink; punctuation uses the shared muted indigo).
const J_KEY = rgb(0x8be9fd), J_STR = rgb(0xf1fa8c), J_NUM = rgb(0xbd93f9), J_LIT = rgb(0xff79c6);

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

// "Name:" in pink, value plain.
function headerLine(l) {
  const i = l.indexOf(":");
  return i < 0 ? [fg(muted)(l)] : [fg(label)(l.slice(0, i + 1)), l.slice(i + 1)];
}

// Split a captured message into wrapped+colored header lines and body lines.
function msgLines(text, width) {
  const sep = text.indexOf("\r\n\r\n");
  const headText = sep >= 0 ? text.slice(0, sep) : text;
  const body = sep >= 0 ? text.slice(sep + 4) : "";
  const hdr = [];
  headText.split(/\r?\n/).forEach((l, j) =>
    wrapTo(l, width).forEach((c, k) => hdr.push(j === 0 ? [bold(c)] : (k === 0 ? headerLine(c) : [c]))));
  let bdy;
  if (!body.trim()) {
    bdy = [[fg(muted)("(no body)")]];
  } else {
    const t = body.trim();
    let src = body;
    if (t.startsWith("{") || t.startsWith("[")) {
      try { src = JSON.stringify(JSON.parse(t), null, 2); } catch { /* truncated: color raw */ }
    }
    bdy = [];
    for (const line of src.split(/\r?\n/)) for (const c of wrapTo(line, width)) bdy.push(colorJsonLine(c));
  }
  return { hdr, bdy };
}

// Max scroll offset of the focused pane, published each render so main.jsx can
// clamp PgUp/PgDn without re-deriving line counts.
export const detailView = { max: 0 };

// Components are called `(opts, ...children)` by the JSX runtime.
function Field(opts, ...children) {
  return (
    <Box direction="row" height="fit">
      <Text width={11}>{fg(label)(opts.name)}</Text>
      <Text width="1fr" overflow="ellipsis">{children.flat(Infinity)}</Text>
    </Box>
  );
}

function statusSpans(status) {
  const codes = Object.entries(status).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (codes.length === 0) return fg(muted)("— none paired");
  return codes.flatMap(([code, n], i) =>
    [i ? "  " : "", bold(fg(statusColor(Number(code)))(code)), fg(muted)(`×${n}`)]);
}

// A bordered, scrollable pane of pre-built display lines.
function Pane({ title, lines, off, vis, focused, h }) {
  const view = lines.slice(off, off + vis);
  return (
    <Box border={{ line: "round", fg: focused ? accent : grid }} direction="column"
      width="1fr" height={`${h}`} overflow="hidden">
      <Text overflow="ellipsis">
        {fg(focused ? accent : label)(title)}
        {lines.length > vis ? fg(muted)(`  ${off + 1}-${Math.min(off + vis, lines.length)}/${lines.length}`) : ""}
      </Text>
      {view.map((l) => <Text height="1" break="none" overflow="hidden">{l}</Text>)}
    </Box>
  );
}

export default function DetailPanel({ focusKey, tick, endpoint, totals, size, txnSel, txnDir, pane, scroll }) {
  return (
    <Box border={{ line: "round", fg: grid }} padding={1} direction="column"
      width="1fr" height="1fr" overflow="hidden">
      {() => {
        tick.get(); txnSel.get(); txnDir.get(); pane.get(); scroll.get();
        const r = endpoint(focusKey.get());
        if (!r) return <Text>{fg(muted)("endpoint no longer tracked — press esc to go back")}</Text>;
        const now = Date.now();
        const share = totals.reqs ? (r.count / totals.reqs) * 100 : 0;
        const lat = r.lat.length
          ? `p50 ${fmtMs(percentile(r.lat, 50))} · p95 ${fmtMs(percentile(r.lat, 95))} · ` +
            `p99 ${fmtMs(percentile(r.lat, 99))} · max ${fmtMs(Math.max(...r.lat))}`
          : fg(muted)("no responses paired yet");

        const { cols, rows } = size.get();
        const txns = r.txns;
        const sel = Math.min(Math.max(0, txnSel.get()), Math.max(0, txns.length - 1));
        const dir = txnDir.get(); // 0 = in (request), 1 = out (response)
        const txn = txns[sel];
        const msg = txn ? (dir === 1 ? txn.out : txn.in) : null;

        // Panes are full width and flex-fill the height below the stats; vis is
        // estimated from the terminal size to size the scroll window.
        const W = Math.max(24, cols - 6);
        const avail = Math.max(6, rows - 12); // rows left for the two panes
        const hVis = Math.max(1, Math.round(avail * 0.4) - 3); // minus border + title
        const bVis = Math.max(1, Math.round(avail * 0.6) - 3);

        const { hdr, bdy } = msg
          ? msgLines(msg, W)
          : { hdr: [[fg(muted)(dir === 1 ? "no response captured" : "no request captured")]], bdy: [[fg(muted)("—")]] };

        const focusBody = pane.get() === 1;
        const maxFor = focusBody ? Math.max(0, bdy.length - bVis) : Math.max(0, hdr.length - hVis);
        detailView.max = maxFor;
        const off = Math.min(Math.max(0, scroll.get()), maxFor);
        const dirLabel = dir === 1 ? "<< out (response)" : ">> in (request)";

        return (
          <Box direction="column" width="1fr" height="1fr">
            <Box direction="row" height="fit">
              <Text width={W_METHOD + 1}>{bold(fg(methodColor(r.method))(r.method))}</Text>
              <Text width="1fr" overflow="ellipsis">{bold(fg(accent)(`${r.host}${r.path}`))}</Text>
            </Box>
            <Field name="Traffic">
              {bold(fg(accent)(fmtCount(r.count)))}{fg(muted)(" reqs  ·  ")}
              {fg(muted)(`${share.toFixed(1)}%  ·  `)}
              {r.rate > 0 ? bold(fg(rateOn)(`${r.rate}/s`)) : fg(muted)("0/s")}
              {fg(muted)(`  ·  ${fmtBytes(r.bytes)}`)}
            </Field>
            <Field name="Latency">{lat}</Field>
            <Field name="Status">{statusSpans(r.status)}</Field>
            <Text overflow="ellipsis">{[
              fg(label)(`txn ${txns.length ? sel + 1 : 0}/${txns.length}`),
              txn ? fg(muted)(`  ·  ${fmtAgo(now - txn.ts)} ago`) : "",
              txn && txn.status ? fg(muted)("  ·  ") : "",
              txn && txn.status ? bold(fg(statusColor(txn.status))(String(txn.status))) : "",
              txn && txn.ms != null ? fg(muted)(`  ·  ${fmtMs(txn.ms)}`) : "",
              fg(muted)("    ↑/↓ txn"),
            ]}</Text>
            <Box direction="column" width="1fr" height="1fr" overflow="hidden">
              <Pane title={`headers  ${dirLabel}`} lines={hdr} off={focusBody ? 0 : off} vis={hVis} focused={!focusBody} h="2fr" />
              <Pane title="body" lines={bdy} off={focusBody ? off : 0} vis={bVis} focused={focusBody} h="3fr" />
            </Box>
          </Box>
        );
      }}
    </Box>
  );
}
