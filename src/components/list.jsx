// List screen: a bordered, flex-filling endpoint table sorted by request
// count. Reads `rows` (the sorted endpoint snapshot) and `sel` (the
// highlighted index); `size` reflows the visible window on resize.
import { Box, Text, bold, dim, fg } from "yeet:tui";
import {
  methodColor, accent, rateOn, grid, selBg,
  W_RANK, W_METHOD, W_COUNT, W_RATE, W_HOST, W_LAST,
  pad, padEnd, fmtCount, fmtAgo,
} from "@/lib/format.js";

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

export default function ListPanel({ rows, sel, size }) {
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
