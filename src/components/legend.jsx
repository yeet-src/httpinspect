// Mode-aware key legend: keys in accent, labels in muted indigo. Reads
// `focusKey` so it swaps between the list-screen and detail-screen bindings.
import { Text, bold, fg } from "yeet:tui";
import { accent, muted } from "@/lib/format.js";

export default function Legend({ focusKey, open }) {
  return (
    <Text>{() => {
      const keys = !focusKey.get()
        ? [["↑/↓", "move"], ["PgUp/Dn", "page"], ["⏎", "requests"], ["q / Ctrl-C", "quit"]]
        : open.get()
          ? [["< >", "in/out"], ["↑/↓", "scroll"], ["esc", "back"]]
          : [["↑/↓", "request"], ["⏎", "open body"], ["esc", "back"]];
      return keys.flatMap(([k, d], i) => [i ? fg(muted)("    ") : "", bold(fg(accent)(k)), fg(muted)(" " + d)]);
    }}</Text>
  );
}
