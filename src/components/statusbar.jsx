// Top status bar: the brand on the left; the right side normally shows the
// watched-interface label, but yields to a red incident banner when an endpoint
// trips the error-rate alert. `topAlert()` reads endpoint stats that mutate in
// place, so the banner re-evaluates off `tick`.
import { Box, bold, dim, fg } from "yeet:tui";
import Cell from "@/components/cell.jsx";
import { accent, errColor, fmtErrPct } from "@/lib/format.js";

export default function StatusBar({ ifaceLabel, tick, topAlert }) {
  return (
    <Box direction="row" height="fit">
      <Cell width="fit">{bold(fg(accent)("httpinspect"))}</Cell>
      <Cell width="1fr">{() => {
        tick.get(); // re-evaluate the alert as endpoint stats mutate in place
        const a = topAlert();
        if (!a) return dim(`  iface: ${ifaceLabel}  ·  plaintext HTTP only`);
        const who = a.client ? `  ·  ${a.client}` : "";
        // A styled span is a run object, not a string — concatenate as an
        // array of children, never with `+` (that would print [object Object]).
        return ["  ", bold(fg(errColor(a.rate))(
          `⚠ ${a.method} ${a.path}  ${fmtErrPct(a.rate)} errors${who}`))];
      }}</Cell>
    </Box>
  );
}
