// Top status bar: the brand on the left, the watched-interface label on the
// right. Pure UI — `ifaceLabel` is the static string the probe resolved.
import { Box, Text, bold, fg } from "yeet:tui";
import { accent, label, muted } from "@/lib/format.js";

export default function StatusBar({ ifaceLabel }) {
  return (
    <Box direction="row" height="fit">
      <Text>{bold(fg(accent)("httpinspect"))}</Text>
      <Text width="1fr">
        {fg(muted)("  iface: ")}{fg(label)(ifaceLabel)}{fg(muted)("  ·  plaintext HTTP only")}
      </Text>
    </Box>
  );
}
