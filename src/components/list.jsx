// List screen: a bordered, flex-filling endpoint table sorted by request
// count. Reads `rows` (the sorted endpoint snapshot) and `sel` (the
// highlighted index); `size` reflows the visible window on resize.
import { Box, Text, bold, dim, fg } from "yeet:tui";
import {
  methodColor, accent, rateOn, grid, selBg,
  W_RANK, W_METHOD, W_COUNT, W_RATE, W_HOST, W_LAST, W_ERR, W_PATH,
  pad, padEnd, cell, fmtCount, fmtAgo, fmtErrPct, errColor,
} from "@/lib/format.js";
import { errRate } from "@/probes/httptop.js";

function HeaderRow() {
  return (
    <Box direction="row" height="fit">
      <Text width={W_RANK}>{dim(cell("#", W_RANK))}</Text>
      <Text width={W_METHOD}>{bold(padEnd("METHOD", W_METHOD))}</Text>
      <Text width={W_HOST}>{bold(padEnd("HOST", W_HOST))}</Text>
      <Text width={W_PATH}>{bold(padEnd("PATH", W_PATH))}</Text>
      <Text width={W_COUNT}>{bold(pad("COUNT", W_COUNT))}</Text>
      <Text width={W_RATE}>{bold(pad("REQ/S", W_RATE))}</Text>
      <Text width={W_ERR}>{bold(pad("ERR%", W_ERR))}</Text>
      <Text width={W_LAST}>{bold(pad("LAST", W_LAST))}</Text>
    </Box>
  );
}

function Row({ row, rank, selected }) {
  const rateStr = row.rate > 0 ? pad(fmtCount(row.rate), W_RATE) : dim(pad("·", W_RATE));
  const er = errRate(row);
  const errCell = pad(fmtErrPct(er), W_ERR);
  // Highlight a real incident: red + bold once the error rate clears the noise band.
  const errSpan = er <= 0 ? dim(errCell)
    : er >= 0.15 ? bold(fg(errColor(er))(errCell))
    : fg(errColor(er))(errCell);
  const rankCell = cell((selected ? "› " : "  ") + rank, W_RANK);
  return (
    <Box direction="row" height="fit" bg={selected ? selBg : undefined}>
      <Text width={W_RANK}>{selected ? fg(accent)(rankCell) : dim(rankCell)}</Text>
      <Text width={W_METHOD}>{fg(methodColor(row.method))(padEnd(row.method, W_METHOD))}</Text>
      <Text width={W_HOST}>{dim(cell(row.host, W_HOST))}</Text>
      <Text width={W_PATH}>{cell(row.path, W_PATH)}</Text>
      <Text width={W_COUNT}>{bold(fg(accent)(pad(fmtCount(row.count), W_COUNT)))}</Text>
      <Text width={W_RATE}>{row.rate > 0 ? fg(rateOn)(rateStr) : rateStr}</Text>
      <Text width={W_ERR}>{errSpan}</Text>
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
