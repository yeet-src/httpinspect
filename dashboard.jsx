/* Panels + layout. `Dashboard` is the view passed to `mount`. It has two
 * screens, switched by the `focusKey` signal:
 *
 *   list   — a status bar, a bordered endpoint table that flexes to fill
 *            (the highlighted row tracks the `sel` signal), and a footer.
 *   detail — a per-endpoint breakdown for the endpoint Enter was pressed on.
 *
 * The bodies read signals from state.js, so they redraw reactively as state
 * ticks and as the user navigates. */

import { Box, Text, bold, dim, fg } from "yeet:tui";

import { rows, totals, info, endpointCount, sel, focusKey, endpoint, tick } from "./state.js";
import {
  METHOD_COLORS, METHOD_FALLBACK, accent, rateOn, grid, selBg, label,
  W_RANK, W_METHOD, W_COUNT, W_RATE, W_HOST, W_LAST,
  pad, padEnd, fmtCount, fmtBytes, fmtAgo, fmtUptime, fmtMs, percentile, statusColor, sparkline,
} from "./render.jsx";

const methodColor = (m) => METHOD_COLORS[m] || METHOD_FALLBACK;

/* ---- status bar / footer ------------------------------------------ */
function StatusBar() {
  return (
    <Box direction="row" height="fit">
      <Text>{bold(fg(accent)("httpinspect"))}</Text>
      <Text width="1fr">{() => dim(`  iface: ${info.ifaceLabel}  ·  plaintext HTTP only`)}</Text>
    </Box>
  );
}

function Footer() {
  return (
    <Text>{() => dim(
      `${fmtCount(totals.reqs)} reqs  ·  ${endpointCount()} endpoints  ·  ` +
      `${fmtBytes(totals.bytes)} seen  ·  up ${fmtUptime(Date.now() - totals.startMs)}`
    )}</Text>
  );
}

/* Mode-aware key legend pinned to the bottom: keys in accent, labels dimmed. */
function Legend() {
  return (
    <Text>{() => {
      const keys = focusKey.get()
        ? [["esc / ←", "back"], ["q", "list"], ["Ctrl-C", "quit"]]
        : [["↑/↓", "move"], ["PgUp/Dn", "page"], ["⏎", "details"], ["q / Ctrl-C", "quit"]];
      return keys.flatMap(([k, d], i) => [i ? dim("    ") : "", fg(accent)(k), dim(" " + d)]);
    }}</Text>
  );
}

/* ---- list screen -------------------------------------------------- */
function HeaderRow() {
  return (
    <Box direction="row" height="fit">
      <Text width={W_RANK}>{dim("#")}</Text>
      <Text width={W_METHOD}>{bold("METHOD")}</Text>
      <Text width={W_HOST}>{bold("HOST")}</Text>
      <Text width="1fr">{bold("PATH")}</Text>
      <Text width={W_COUNT}>{bold(pad("COUNT", W_COUNT))}</Text>
      <Text width={W_RATE}>{bold(pad("REQ/S", W_RATE))}</Text>
      <Text width={W_LAST}>{bold(pad("LAST", W_LAST))}</Text>
    </Box>
  );
}

function Row({ row, rank, selected }) {
  const rateStr = row.rate > 0 ? pad(fmtCount(row.rate), W_RATE) : dim(pad("·", W_RATE));
  return (
    <Box direction="row" height="fit" bg={selected ? selBg : undefined}>
      <Text width={W_RANK}>{selected ? fg(accent)("› " + pad(rank, 2).slice(1)) : dim(pad(rank, 2) + " ")}</Text>
      <Text width={W_METHOD}>{fg(methodColor(row.method))(padEnd(row.method, W_METHOD))}</Text>
      <Text width={W_HOST} overflow="ellipsis">{dim(row.host)}</Text>
      <Text width="1fr" overflow="ellipsis">{row.path}</Text>
      <Text width={W_COUNT}>{bold(fg(accent)(pad(fmtCount(row.count), W_COUNT)))}</Text>
      <Text width={W_RATE}>{row.rate > 0 ? fg(rateOn)(rateStr) : rateStr}</Text>
      <Text width={W_LAST}>{dim(pad(fmtAgo(Date.now() - row.last), W_LAST))}</Text>
    </Box>
  );
}

/* Scroll window top, kept across renders so the highlight stays on-screen as
 * the user pages past the visible rows. */
let listTop = 0;

function ListPanel({ size }) {
  return (
    <Box border={{ line: "round", fg: grid }} padding={[0, 1]} direction="column"
      width="1fr" height="1fr" overflow="hidden">
      <HeaderRow />
      <Text width="1fr" break="none" overflow="hidden">{dim("─".repeat(400))}</Text>
      {() => {
        const data = rows.get();
        const vis = Math.max(3, size.get().rows - 8);
        if (data.length === 0) {
          return <Text>{dim("waiting for HTTP requests…  (try: curl http://localhost:PORT/path)")}</Text>;
        }
        const cur = Math.max(0, Math.min(data.length - 1, sel.get()));
        // Keep the selection inside the visible window [listTop, listTop+vis).
        if (cur < listTop) listTop = cur;
        else if (cur >= listTop + vis) listTop = cur - vis + 1;
        listTop = Math.max(0, Math.min(listTop, Math.max(0, data.length - vis)));
        return data.slice(listTop, listTop + vis).map((row, i) =>
          <Row row={row} rank={listTop + i + 1} selected={listTop + i === cur} />);
      }}
    </Box>
  );
}

/* ---- detail screen ------------------------------------------------ */
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

function DetailPanel({ size }) {
  return (
    <Box border={{ line: "round", fg: grid }} padding={1} direction="column"
      width="1fr" height="1fr" overflow="hidden">
      {() => {
        tick.get(); // re-render on each state tick (fields below mutate in place)
        const r = endpoint(focusKey.get());
        if (!r) return <Text>{dim("endpoint no longer tracked — press esc to go back")}</Text>;
        const now = Date.now();
        const share = totals.reqs ? (r.count / totals.reqs) * 100 : 0;
        const sparkW = Math.max(10, Math.min(r.hist.length || 1, size.get().cols - 18));
        const lat = r.lat.length
          ? `p50 ${fmtMs(percentile(r.lat, 50))}  ·  p95 ${fmtMs(percentile(r.lat, 95))}  ·  ` +
            `max ${fmtMs(Math.max(...r.lat))}  ${"·"}  ${r.lat.length} samples`
          : dim("no responses paired yet");
        return [
          <Box direction="row" height="fit">
            <Text width={W_METHOD + 1}>{bold(fg(methodColor(r.method))(r.method))}</Text>
            <Text width="1fr" overflow="ellipsis">{bold(`${r.host}${r.path}`)}</Text>
          </Box>,
          <Text> </Text>,
          <Field name="Requests">{bold(fg(accent)(fmtCount(r.count)))}{dim(`  (${r.count})`)}</Field>,
          <Field name="Share">{`${share.toFixed(1)}% of all requests`}</Field>,
          <Field name="Req/s now">{r.rate > 0 ? fg(rateOn)(String(r.rate)) : dim("0")}{dim(`   peak ${r.peak}/s`)}</Field>,
          <Field name="Latency">{lat}</Field>,
          <Field name="Status">{statusSpans(r.status)}</Field>,
          <Field name="Bytes">{fmtBytes(r.bytes)}{dim(" on the wire")}</Field>,
          <Field name="First seen">{`${fmtAgo(now - r.first)} ago`}</Field>,
          <Field name="Last seen">{`${fmtAgo(now - r.last)} ago`}</Field>,
          <Text> </Text>,
          <Text>{fg(label)("Req/s, last minute")}</Text>,
          <Text overflow="hidden">{fg(rateOn)(sparkline(r.hist, sparkW, r.peak))}</Text>,
          <Text> </Text>,
          <Text>{fg(label)("Latency, recent responses")}</Text>,
          <Text overflow="hidden">{fg(accent)(sparkline(r.lat, sparkW))}</Text>,
        ];
      }}
    </Box>
  );
}

/* ---- root --------------------------------------------------------- */
export const Dashboard = (size) => (
  <Box direction="column" width="1fr" height="1fr" padding={[0, 1]}>
    <StatusBar />
    {() => focusKey.get() ? <DetailPanel size={size} /> : <ListPanel size={size} />}
    <Footer />
    <Legend />
  </Box>
);
