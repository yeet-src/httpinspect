// Top status bar: the brand on the left; the right side normally shows the
// watched-interface label, but yields to a red incident banner when an endpoint
// trips the error-rate alert. `topAlert()` reads endpoint stats that mutate in
// place, so the banner re-evaluates off `tick`.
import { Box, Text, bold, dim, fg } from "yeet:tui";
import { accent, errColor, fmtErrPct } from "@/lib/format.js";

export default function StatusBar({ ifaceLabel, tick, topAlert }) {
  return (
    <Box direction="row" height="fit">
      <Text>{bold(fg(accent)("httpinspect"))}</Text>
      <Text width="1fr">{() => {
        tick.get(); // re-evaluate the alert as endpoint stats mutate in place
        const a = topAlert();
        if (!a) return dim(`  iface: ${ifaceLabel}  ·  plaintext HTTP only`);
        const who = a.client ? `  ·  ${a.client}` : "";
        return "  " + bold(fg(errColor(a.rate))(
          `⚠ ${a.method} ${a.path}  ${fmtErrPct(a.rate)} errors${who}`));
      }}</Text>
    </Box>
  );
}
