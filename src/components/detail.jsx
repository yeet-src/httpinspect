// Detail screen: a per-endpoint breakdown for the endpoint the user pressed
// Enter on. Reads `focusKey` (which endpoint) and `tick` — the endpoint's
// fields mutate in place, so reading `tick` is what re-renders this panel as
// they change. `endpoint()` looks the row up; `totals` gives the share.
import { Box, Text, bold, dim, fg } from "yeet:tui";
import {
  methodColor, accent, rateOn, grid, label, W_METHOD,
  fmtCount, fmtBytes, fmtAgo, fmtMs, percentile, statusColor, sparkline,
} from "@/lib/format.js";

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

export default function DetailPanel({ focusKey, tick, endpoint, totals, size }) {
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
