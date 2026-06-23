// Top status bar: the brand on the left, the watched-interface label on the
// right. Pure UI — `ifaceLabel` is the static string the probe resolved.
import { Box, Text, bold, dim, fg } from "yeet:tui";
import { accent } from "@/lib/format.js";

export default function StatusBar({ ifaceLabel }) {
  return (
    <Box direction="row" height="fit">
      <Text>{bold(fg(accent)("httpinspect"))}</Text>
      <Text width="1fr">{dim(`  iface: ${ifaceLabel}  ·  plaintext HTTP only`)}</Text>
    </Box>
  );
}
