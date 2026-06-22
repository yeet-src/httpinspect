// Running totals pinned to the bottom. Reads the plain `totals` object every
// render; the uptime ticks because the surrounding tree re-renders on state
// ticks (the list via `rows`, the detail screen via `tick`).
import { Text, dim } from "yeet:tui";
import { fmtCount, fmtBytes, fmtUptime } from "@/lib/format.js";

export default function Footer({ totals, endpointCount }) {
  return (
    <Text>{() => dim(
      `${fmtCount(totals.reqs)} reqs  ·  ${endpointCount()} endpoints  ·  ` +
      `${fmtBytes(totals.bytes)} seen  ·  up ${fmtUptime(Date.now() - totals.startMs)}`
    )}</Text>
  );
}
