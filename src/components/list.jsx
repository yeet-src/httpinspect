// List screen: a bordered, flex-filling endpoint table sorted by request
// count. Reads `rows` (the sorted endpoint snapshot) and `sel` (the
// highlighted index); `size` reflows the visible window on resize.
import { Box, Text, bold, fg } from "yeet:tui";
import {
  methodColor, accent, rateOn, grid, selBg, muted, statusColor, statusClasses, latColor, percentile,
  W_RANK, W_METHOD, W_RATE, W_HOST, W_LAST, W_STATUS, W_LAT,
  pad, padEnd, fmtCount, fmtRate, fmtAgo, fmtMs,
} from "@/lib/format.js";

/* Smooth the instantaneous per-second rate over the last ~10s of history so the
 * RPS column shows a meaningful fractional value instead of a jumpy integer. */
function smoothRate(row) {
  const h = row.hist;
  if (!h?.length) return row.rate;
  const n = Math.min(10, h.length);
  let sum = 0;
  for (let i = h.length - n; i < h.length; i++) sum += h[i];
  return sum / n;
}

const STATUS_CLASSES = [2, 3, 4, 5];

function HeaderRow() {
  return (
    <Box direction="row" height="fit">
      <Text width={W_RANK}>{fg(muted)("#")}</Text>
      <Text width={W_METHOD}>{bold(fg(accent)("METHOD"))}</Text>
      <Text width={W_HOST}>{bold(fg(accent)("HOST"))}</Text>
      <Text width="1fr">{bold(fg(accent)("PATH"))}</Text>
      {STATUS_CLASSES.map((c) => (
        <Text width={W_STATUS}>{bold(fg(statusColor(c * 100))(pad(`${c}xx`, W_STATUS)))}</Text>
      ))}
      <Text width={W_RATE}>{bold(fg(accent)(pad("RPS", W_RATE)))}</Text>
      <Text width={W_LAT}>{bold(fg(accent)(pad("P99", W_LAT)))}</Text>
      <Text width={W_LAST}>{bold(fg(accent)(pad("LAST", W_LAST)))}</Text>
    </Box>
  );
}

function Row({ row, rank, selected }) {
  const rps = smoothRate(row);
  const rateStr = rps > 0 ? pad(fmtRate(rps), W_RATE) : fg(muted)(pad("·", W_RATE));
  const status = statusClasses(row.status);
  const p99 = row.lat?.length ? percentile(row.lat, 99) : null;
  return (
    <Box direction="row" height="fit" bg={selected ? selBg : undefined}>
      <Text width={W_RANK}>{selected ? fg(accent)("› " + pad(rank, 2).slice(1)) : fg(muted)(pad(rank, 2) + " ")}</Text>
      <Text width={W_METHOD}>{bold(fg(methodColor(row.method))(padEnd(row.method, W_METHOD)))}</Text>
      <Text width={W_HOST} overflow="ellipsis">{fg(muted)(row.host)}</Text>
      <Text width="1fr" overflow="ellipsis">{bold(row.path)}</Text>
      {STATUS_CLASSES.map((c) => (
        <Text width={W_STATUS}>
          {status[c] > 0 ? fg(statusColor(c * 100))(pad(fmtCount(status[c]), W_STATUS)) : fg(muted)(pad("·", W_STATUS))}
        </Text>
      ))}
      <Text width={W_RATE}>{rps > 0 ? fg(rateOn)(rateStr) : rateStr}</Text>
      <Text width={W_LAT}>{p99 != null ? fg(latColor(p99))(pad(fmtMs(p99), W_LAT)) : fg(muted)(pad("·", W_LAT))}</Text>
      <Text width={W_LAST}>{fg(muted)(pad(fmtAgo(Date.now() - row.last), W_LAST))}</Text>
    </Box>
  );
}

/* Scroll window top, kept across renders so the highlight stays on-screen as
 * the user pages past the visible rows. */
let listTop = 0;

export default function ListPanel({ rows, sel, size }) {
  return (
    <Box border={{ line: "round", fg: grid }} padding={[0, 1]} direction="column"
      width="1fr" height="1fr" overflow="hidden">
      <HeaderRow />
      <Text width="1fr" break="none" overflow="hidden">{fg(grid)("─".repeat(400))}</Text>
      {() => {
        const data = rows.get();
        const vis = Math.max(3, size.get().rows - 8);
        if (data.length === 0) {
          return <Text>{fg(muted)("waiting for HTTP requests…  (try: curl http://localhost:PORT/path)")}</Text>;
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
