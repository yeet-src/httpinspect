// Running totals pinned to the bottom. `totals` is a plain object and
// `endpointCount()` reads a plain Map, so neither makes this reactive on its
// own — the thunk reads the `tick` signal (bumped every redraw in httptop.js)
// to re-render, which is what advances reqs/bytes/uptime.
import { Text, dim } from "yeet:tui";
import { fmtCount, fmtBytes, fmtUptime } from "@/lib/format.js";

export default function Footer({ totals, endpointCount, tick }) {
  return (
    <Text>{() => {
      tick.get(); // dependency: re-render on each sample/redraw tick
      return dim(
        `${fmtCount(totals.reqs)} reqs  ·  ${endpointCount()} endpoints  ·  ` +
        `${fmtBytes(totals.bytes)} seen  ·  up ${fmtUptime(Date.now() - totals.startMs)}`
      );
    }}</Text>
  );
}
