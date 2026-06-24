// Detail: a two-screen drill for one endpoint.
//   • requests table — a Wireshark-style list of the endpoint's recent calls
//     (one row each: #, age, status, latency, size). ↑/↓ select, ⏎ to open.
//   • body view — the opened request's headers + body, scrollable, with `<`/`>`
//     flipping the in (request) / out (response). esc steps back out.
// Reads `focusKey`, `tick`, and the nav signals (`txnSel`, `open`, `txnDir`,
// `scroll`). `open` distinguishes the two screens.
import { Box, Text, bold, fg, rgb } from "yeet:tui";
import {
  methodColor, accent, rateOn, grid, label, muted, selBg, W_METHOD,
  fmtCount, fmtBytes, fmtAgo, fmtMs, statusColor, latColor,
} from "@/lib/format.js";

// Vibrant JSON syntax palette.
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

function wrapTo(line, width) {
  if (line.length <= width) return [line];
  const out = [];
  for (let i = 0; i < line.length; i += width) out.push(line.slice(i, i + width));
  return out;
}

function headerLine(l) {
  const i = l.indexOf(":");
  return i < 0 ? [fg(muted)(l)] : [fg(label)(l.slice(0, i + 1)), l.slice(i + 1)];
}

// A captured message → wrapped+colored display lines. Headers and body are
// collapsible sections (▾ open / ▸ collapsed), driven by hOpen/bOpen.
function msgLines(text, width, hOpen, bOpen) {
  const sep = text.indexOf("\r\n\r\n");
  const headText = sep >= 0 ? text.slice(0, sep) : text;
  const body = sep >= 0 ? text.slice(sep + 4) : "";
  const rule = (lbl) => [fg(label)(`${lbl} ` + "─".repeat(Math.max(0, width - lbl.length - 1)))];
  const headerCount = headText.split(/\r?\n/).length;

  const out = [rule(`${hOpen ? "▾" : "▸"} headers (${headerCount})`)];
  if (hOpen) {
    headText.split(/\r?\n/).forEach((l, j) =>
      wrapTo(l, width).forEach((c, k) => out.push(j === 0 ? [bold(c)] : (k === 0 ? headerLine(c) : [c]))));
  }

  out.push([" "], rule(`${bOpen ? "▾" : "▸"} body`));
  if (bOpen) {
    const t = body.trim();
    if (!t) {
      out.push([fg(muted)("(no body)")]);
    } else {
      let src = body;
      if (t.startsWith("{") || t.startsWith("[")) {
        try { src = JSON.stringify(JSON.parse(t), null, 2); } catch { /* truncated: color raw */ }
      }
      for (const line of src.split(/\r?\n/)) for (const c of wrapTo(line, width)) out.push(colorJsonLine(c));
    }
  }
  return out;
}

// Max scroll offset of the body view, published each render for main.jsx.
export const detailView = { max: 0 };
// Top row of the requests-table window, kept across renders.
let tableTop = 0;

function statusSpans(status) {
  const codes = Object.entries(status).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (codes.length === 0) return fg(muted)("none paired");
  return codes.flatMap(([code, n], i) =>
    [i ? "  " : "", bold(fg(statusColor(Number(code)))(code)), fg(muted)(`×${n}`)]);
}

// Endpoint header shown on both screens.
function endpointHead(r, totals) {
  const share = totals.reqs ? (r.count / totals.reqs) * 100 : 0;
  return [
    <Box direction="row" height="fit">
      <Text width={W_METHOD + 1}>{bold(fg(methodColor(r.method))(r.method))}</Text>
      <Text width="1fr" overflow="ellipsis">{bold(fg(accent)(`${r.host}${r.path}`))}</Text>
    </Box>,
    <Text overflow="ellipsis">{[
      bold(fg(accent)(fmtCount(r.count))), fg(muted)(" reqs  ·  "),
      fg(muted)(`${share.toFixed(1)}%  ·  `),
      r.rate > 0 ? bold(fg(rateOn)(`${r.rate}/s`)) : fg(muted)("0/s"),
      fg(muted)("  ·  "), ...[].concat(statusSpans(r.status)),
    ]}</Text>,
  ];
}

// ---- requests table (Wireshark-style packet list) ----
// Width-based columns (a single padded Text gets its spaces trimmed, which
// collapses the columns) — one Text per cell, like the endpoint list.
const C_TIME = 9, C_CODE = 6, C_LAT = 9, C_SIZE = 8;

function tableHeader() {
  return (
    <Box direction="row" height="1">
      <Text width={2}>{" "}</Text>
      <Text width={C_TIME}>{bold(fg(accent)("Time"))}</Text>
      <Text width={C_CODE}>{bold(fg(accent)("Code"))}</Text>
      <Text width={C_LAT}>{bold(fg(accent)("Latency"))}</Text>
      <Text width={C_SIZE}>{bold(fg(accent)("Size"))}</Text>
      <Text width="1fr">{bold(fg(accent)("Info"))}</Text>
    </Box>
  );
}

function tableRow(t, on, now) {
  const info = t.in.split(/\r?\n/)[0] || "";
  const method = info.split(" ")[0] || "";
  return (
    <Box direction="row" height="1" bg={on ? selBg : undefined}>
      <Text width={2}>{on ? fg(accent)("▸") : " "}</Text>
      <Text width={C_TIME}>{fg(on ? accent : muted)(`${fmtAgo(now - t.ts)} ago`)}</Text>
      <Text width={C_CODE}>{t.status ? bold(fg(statusColor(t.status))(String(t.status))) : fg(muted)(t.out === null ? "·" : "—")}</Text>
      <Text width={C_LAT}>{t.ms != null ? fg(latColor(t.ms))(fmtMs(t.ms)) : fg(muted)("·")}</Text>
      <Text width={C_SIZE}>{fg(muted)(fmtBytes((t.in?.length || 0) + (t.out?.length || 0)))}</Text>
      <Text width="1fr" overflow="ellipsis">{fg(methodColor(method))(method)}{fg(on ? accent : muted)(info.slice(method.length))}</Text>
    </Box>
  );
}

export default function DetailPanel({ focusKey, tick, endpoint, totals, size, txnSel, open, txnDir, scroll, hOpen, bOpen }) {
  return (
    <Box border={{ line: "round", fg: grid }} padding={1} direction="column"
      width="1fr" height="1fr" overflow="hidden">
      {() => {
        tick.get(); txnSel.get(); open.get(); txnDir.get(); scroll.get(); hOpen.get(); bOpen.get();
        const r = endpoint(focusKey.get());
        if (!r) return <Text>{fg(muted)("endpoint no longer tracked — press esc to go back")}</Text>;
        const now = Date.now();
        const { rows, cols } = size.get();
        const txns = r.txns;
        const sel = Math.min(Math.max(0, txnSel.get()), Math.max(0, txns.length - 1));

        if (!open.get()) {
          // ── requests table ──
          const vis = Math.max(3, rows - 9);
          if (sel < tableTop) tableTop = sel;
          else if (sel >= tableTop + vis) tableTop = sel - vis + 1;
          tableTop = Math.max(0, Math.min(tableTop, Math.max(0, txns.length - vis)));
          return (
            <Box direction="column" width="1fr" height="1fr">
              {endpointHead(r, totals)}
              <Text overflow="ellipsis">{fg(label)(`requests (${txns.length})`)}{fg(muted)("   ↑/↓ select · ⏎ open · esc back")}</Text>
              {txns.length === 0
                ? <Text>{fg(muted)("no requests captured yet")}</Text>
                : [tableHeader(), ...txns.slice(tableTop, tableTop + vis).map((t, i) => tableRow(t, tableTop + i === sel, now))]}
            </Box>
          );
        }

        // ── body view ──
        const txn = txns[sel];
        const dir = txnDir.get(); // 0 = in (request), 1 = out (response)
        const msg = txn ? (dir === 1 ? txn.out : txn.in) : null;
        const W = Math.max(24, cols - 6);
        const lines = msg ? msgLines(msg, W, hOpen.get(), bOpen.get())
          : [[fg(muted)(dir === 1 ? "no response captured (egress not seen)" : "no request captured")]];
        const vis = Math.max(3, rows - 8);
        detailView.max = Math.max(0, lines.length - vis);
        const off = Math.min(Math.max(0, scroll.get()), detailView.max);
        const dirLabel = dir === 1 ? "<< out (response)" : ">> in (request)";
        return (
          <Box direction="column" width="1fr" height="1fr">
            {endpointHead(r, totals)}
            <Text overflow="ellipsis">
              {fg(label)(`req ${txns.length ? sel + 1 : 0}/${txns.length}  ·  ${dirLabel}`)}
              {txn && txn.status ? [fg(muted)("  ·  "), bold(fg(statusColor(txn.status))(String(txn.status)))] : ""}
              {txn && txn.ms != null ? fg(muted)(`  ·  ${fmtMs(txn.ms)}`) : ""}
              {fg(muted)("   < > in/out · h/b collapse · ↑/↓ scroll · esc")}
            </Text>
            <Box direction="column" width="1fr" height="1fr" overflow="hidden">
              {lines.slice(off, off + vis).map((l) => <Text height="1" break="none" overflow="hidden">{l}</Text>)}
            </Box>
          </Box>
        );
      }}
    </Box>
  );
}
