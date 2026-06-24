// Running totals pinned to the bottom. `totals` is a plain object and
// `endpointCount()` reads a plain Map, so neither makes this reactive on its
// own — the thunk reads the `tick` signal (bumped every redraw in httptop.js)
// to re-render, which is what advances the counters.
import { Text, bold, fg } from "yeet:tui";
import { accent, rateOn, muted, label, fmtCount, fmtBytes, fmtUptime } from "@/lib/format.js";

export default function Footer({ totals, endpointCount, tick }) {
  return (
    <Text>{() => {
      tick.get(); // dependency: re-render on each sample/redraw tick
      const sep = fg(muted)("  ·  ");
      return [
        bold(fg(accent)(fmtCount(totals.reqs))), fg(muted)(" reqs"), sep,
        bold(fg(rateOn)(String(endpointCount()))), fg(muted)(" endpoints"), sep,
        bold(fg(label)(fmtBytes(totals.bytes))), fg(muted)(" seen"), sep,
        fg(muted)("up "), bold(fg(accent)(fmtUptime(Date.now() - totals.startMs))),
      ];
    }}</Text>
  );
}
