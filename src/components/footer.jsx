// Running totals pinned to the bottom. `totals` is a plain object that the
// ingest mutates in place, so nothing here would re-render on its own — a
// node re-renders only when a signal it *read* changes, and a parent
// re-rendering does not re-mint its children. Reading `tick` is what keeps
// the counts and uptime moving.
import { dim } from "yeet:tui";
import Cell from "@/components/cell.jsx";
import { fmtCount, fmtBytes, fmtUptime } from "@/lib/format.js";

export default function Footer({ totals, endpointCount, tick }) {
  return (
    <Cell>{() => {
      tick.get();
      return dim(
        `${fmtCount(totals.reqs)} reqs  ·  ${endpointCount()} endpoints  ·  ` +
        `${fmtBytes(totals.bytes)} seen  ·  up ${fmtUptime(Date.now() - totals.startMs)}`);
    }}</Cell>
  );
}
