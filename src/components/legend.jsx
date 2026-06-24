// Mode-aware key legend: keys in accent, labels in muted indigo. Reads
// `focusKey` so it swaps between the list-screen and detail-screen bindings.
import { Text, bold, fg } from "yeet:tui";
import { accent, muted } from "@/lib/format.js";

export default function Legend({ focusKey }) {
  return (
    <Text>{() => {
      const keys = focusKey.get()
        ? [["↑/↓", "payload"], ["PgUp/Dn", "scroll"], ["esc / ←", "back"], ["q", "quit"]]
        : [["↑/↓", "move"], ["PgUp/Dn", "page"], ["⏎", "details"], ["q / Ctrl-C", "quit"]];
      return keys.flatMap(([k, d], i) => [i ? fg(muted)("    ") : "", bold(fg(accent)(k)), fg(muted)(" " + d)]);
    }}</Text>
  );
}
