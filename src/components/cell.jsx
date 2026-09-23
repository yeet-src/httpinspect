// A one-line table cell. In yeet:tui a <Text> is an inline styled run — a
// value, not a placement — so `width` on a Text is ignored. Size, wrap and
// clipping live on the container: this Box owns the column width, never
// wraps, and clips what doesn't fit. The children are wrapped in one <Text>
// so several spans concat into a single run — a Box would stack them as
// separate leaves. Right-alignment is still the caller's job (pad the
// string), because a Box doesn't align its text.
import { Box, Text } from "yeet:tui";

export default function Cell({ width = "1fr", overflow = "hidden", ...rest }, ...children) {
  return (
    <Box width={width} height={1} break="none" overflow={overflow} {...rest}>
      <Text>{children}</Text>
    </Box>
  );
}
