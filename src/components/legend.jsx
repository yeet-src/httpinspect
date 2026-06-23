// Mode-aware key legend: keys in accent, labels dimmed. Reads `focusKey` so it
// swaps between the list-screen and detail-screen bindings reactively.
import { Text, dim, fg } from "yeet:tui";
import { accent } from "@/lib/format.js";

export default function Legend({ focusKey }) {
  return (
    <Text>{() => {
      const keys = focusKey.get()
        ? [["esc / ←", "back"], ["q", "list"], ["Ctrl-C", "quit"]]
        : [["↑/↓", "move"], ["PgUp/Dn", "page"], ["⏎", "details"], ["q / Ctrl-C", "quit"]];
      return keys.flatMap(([k, d], i) => [i ? dim("    ") : "", fg(accent)(k), dim(" " + d)]);
    }}</Text>
  );
}
