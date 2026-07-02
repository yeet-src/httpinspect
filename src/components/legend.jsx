// Mode-aware key legend: keys in accent, labels dimmed. Reads `focusKey` so it
// swaps between the list-screen and detail-screen bindings reactively, and
// `sortMode` so the `e` hint shows the order it will switch the list into.
import { Text, dim, fg } from "yeet:tui";
import { accent } from "@/lib/format.js";

export default function Legend({ focusKey, sortMode }) {
  return (
    <Text>{() => {
      const keys = focusKey.get()
        ? [["esc / ←", "back"], ["q", "list"], ["Ctrl-C", "quit"]]
        : [["↑/↓", "move"], ["PgUp/Dn", "page"], ["⏎", "details"],
           ["e", `sort: ${sortMode.get()}`], ["q / Ctrl-C", "quit"]];
      return keys.flatMap(([k, d], i) => [i ? dim("    ") : "", fg(accent)(k), dim(" " + d)]);
    }}</Text>
  );
}
