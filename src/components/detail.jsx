// Detail screen: a per-endpoint breakdown for the endpoint the user pressed
// Enter on. Reads `focusKey` (which endpoint) and `tick` — the endpoint's
// fields mutate in place, so reading `tick` is what re-renders this panel as
// they change. `endpoint()` looks the row up; `totals` gives the share.
import { Box, bold, dim, fg } from "yeet:tui";
import Cell from "@/components/cell.jsx";
import {
  methodColor, accent, rateOn, grid, label, W_METHOD, W_COUNT, W_ERR,
  fmtCount, fmtBytes, fmtAgo, fmtMs, percentile, statusColor, sparkline,
  errColor, fmtErrPct, pad,
} from "@/lib/format.js";
import { errRate } from "@/probes/httptop.js";

// Components are called `(opts, ...children)` by the JSX runtime, so read the
// value pieces from the rest args — not a `children` prop. The label sits in
// a fixed-width Cell — a <Text> has no width, so the Box is what makes the
// gutter between name and value.
const W_LABEL = 12;
function Field(opts, ...children) {
  return (
    <Box direction="row" height="fit">
      <Cell width={W_LABEL}>{fg(label)(opts.name)}</Cell>
      <Cell width="1fr" overflow="ellipsis">{children.flat(Infinity)}</Cell>
    </Box>
  );
}

/* "5s ago", but a sub-second age reads "now", not "now ago". */
const ago = (ms) => { const s = fmtAgo(ms); return s === "now" ? s : `${s} ago`; };

/* Status-code tallies as colored "200×120  404×3" spans, busiest first. */
function statusSpans(status) {
  const codes = Object.entries(status).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (codes.length === 0) return dim("— no responses paired yet");
  return codes.flatMap(([code, n], i) =>
    [i ? "  " : "", fg(statusColor(Number(code)))(code), dim(`×${n}`)]);
}

/* The "by client" abuse breakdown: which callers drive this endpoint's traffic
 * and its errors. Worst offender first (errors, then volume), top 6. */
function clientRows(clients) {
  const list = [...clients.entries()]
    .map(([id, c]) => ({ id, count: c.count, errs: c.errs, er: c.count ? c.errs / c.count : 0 }))
    .sort((a, b) => b.errs - a.errs || b.count - a.count)
    .slice(0, 6);
  if (!list.length) return [<Cell>{dim("— no clients seen yet")}</Cell>];
  return list.map((c) => (
    <Box direction="row" height="fit">
      <Cell width="1fr" overflow="ellipsis">{c.errs > 0 ? c.id : dim(c.id)}</Cell>
      <Cell width={W_COUNT}>{pad(fmtCount(c.count), W_COUNT)}</Cell>
      <Cell width={W_ERR}>{fg(errColor(c.er))(pad(fmtErrPct(c.er), W_ERR))}</Cell>
    </Box>
  ));
}

export default function DetailPanel({ focusKey, tick, endpoint, totals, size }) {
  return (
    <Box border={{ line: "round", fg: grid }} padding={1} direction="column"
      width="1fr" height="1fr" overflow="hidden">
      {() => {
        tick.get(); // re-render on each state tick (fields below mutate in place)
        const r = endpoint(focusKey.get());
        if (!r) return <Cell>{dim("endpoint no longer tracked — press esc to go back")}</Cell>;
        const now = Date.now();
        const share = totals.reqs ? (r.count / totals.reqs) * 100 : 0;
        const sparkW = Math.max(10, Math.min(r.hist.length || 1, size.get().cols - 18));
        const lat = r.lat.length
          ? `p50 ${fmtMs(percentile(r.lat, 50))}  ·  p95 ${fmtMs(percentile(r.lat, 95))}  ·  ` +
            `max ${fmtMs(Math.max(...r.lat))}  ${"·"}  ${r.lat.length} samples`
          : dim("no responses paired yet");
        return [
          <Box direction="row" height="fit">
            <Cell width={W_METHOD + 1}>{bold(fg(methodColor(r.method))(r.method))}</Cell>
            <Cell width="1fr" overflow="ellipsis">{bold(`${r.host}${r.path}`)}</Cell>
          </Box>,
          <Box height={1} />,
          <Field name="Requests">{bold(fg(accent)(fmtCount(r.count)))}{dim(`  (${r.count})`)}</Field>,
          <Field name="Share">{`${share.toFixed(1)}% of all requests`}</Field>,
          <Field name="Req/s now">{r.rate > 0 ? fg(rateOn)(String(r.rate)) : dim("0")}{dim(`   peak ${r.peak}/s`)}</Field>,
          <Field name="Latency">{lat}</Field>,
          <Field name="Status">{statusSpans(r.status)}</Field>,
          <Field name="Errors">{r.respTotal ? [
            bold(fg(errColor(errRate(r)))(fmtErrPct(errRate(r)))),
            dim(`  ${r.err4} 4xx · ${r.err5} 5xx  of ${r.respTotal} paired`),
          ] : dim("no responses paired yet")}</Field>,
          <Field name="Bytes">{fmtBytes(r.bytes)}{dim(" on the wire")}</Field>,
          <Field name="First seen">{ago(now - r.first)}</Field>,
          <Field name="Last seen">{ago(now - r.last)}</Field>,
          <Box height={1} />,
          <Cell>{fg(label)("Req/s, last minute")}</Cell>,
          <Cell>{fg(rateOn)(sparkline(r.hist, sparkW, r.peak))}</Cell>,
          <Box height={1} />,
          <Cell>{fg(label)("Latency, recent responses")}</Cell>,
          <Cell>{fg(accent)(sparkline(r.lat, sparkW))}</Cell>,
          <Box height={1} />,
          <Cell>{fg(label)("Errors/s, last minute")}</Cell>,
          <Cell>{fg(errColor(errRate(r)))(sparkline(r.ehist, sparkW))}</Cell>,
          <Box height={1} />,
          <Box direction="row" height="fit">
            <Cell width="1fr">{fg(label)("By client (worst first)")}</Cell>
            <Cell width={W_COUNT}>{fg(label)(pad("REQS", W_COUNT))}</Cell>
            <Cell width={W_ERR}>{fg(label)(pad("ERR%", W_ERR))}</Cell>
          </Box>,
          ...clientRows(r.clients),
        ];
      }}
    </Box>
  );
}
