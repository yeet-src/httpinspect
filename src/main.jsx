// httptop — a live dashboard of the most active plaintext HTTP endpoints on
// this host. An eBPF program at the TC layer ships HTTP request lines to JS;
// probes/httptop.js parses method + Host + path and aggregates by endpoint,
// and the components render a sorted, auto-refreshing table.
//
//   yeet run .                 # watch every up interface (incl. loopback)
//   yeet run . -- --iface lo,eth0   # only these interfaces
//   yeet run . -- --keep-query      # don't collapse the query string into the path
//
// Plaintext HTTP only — HTTPS payloads are ciphertext at this layer.
//
// Layout follows the project convention: probes/ (BPF-aware) → components/
// (pure UI) → lib/ (pure helpers), composed here through the `@/` source
// alias. This module owns input and navigation; the data layer is loaded by
// importing probes/probe.js (the shared object) and probes/httptop.js (ingest).
import { Box, mount, signal } from "yeet:tui";
import { ifaceLabel } from "@/probes/probe.js";
import { rows, totals, tick, endpoint, endpointCount, keyOf } from "@/probes/httptop.js";
import StatusBar from "@/components/statusbar.jsx";
import ListPanel from "@/components/list.jsx";
import DetailPanel from "@/components/detail.jsx";
import Footer from "@/components/footer.jsx";
import Legend from "@/components/legend.jsx";

// The TUI needs a real terminal: in non-TTY mode (piped/redirected output)
// yeet never installs the `tty` global, and `mount`'s `term = tty` default
// would throw a bare `ReferenceError: tty is not defined` with no output.
// Fail loudly instead.
if (typeof tty === "undefined") {
  console.error("[httptop] needs an interactive terminal — don't pipe or redirect output (and avoid --no-tty).");
  yeet.exit();
}

// ── navigation ───────────────────────────────────────────────────────────────
// The dashboard has two screens. In the list, `sel` is the highlighted row
// index. `focusKey` is null in the list and the pinned endpoint key when the
// per-endpoint detail screen is open. Both are signals so the view reacts.
const sel = signal(0);
const focusKey = signal(null);
const detailSel = signal(0); // which payload is expanded in the detail accordion

function moveSel(delta) {
  const n = rows.get().length;
  if (n === 0) return;
  sel.set(Math.max(0, Math.min(n - 1, sel.get() + delta)));
}

/* Enter the detail screen for the currently highlighted endpoint. */
function enterDetail() {
  const data = rows.get();
  if (data.length === 0) return;
  const row = data[Math.max(0, Math.min(data.length - 1, sel.get()))];
  if (row) { detailSel.set(0); focusKey.set(keyOf(row)); }
}

const exitDetail = () => focusKey.set(null);

// ── root ─────────────────────────────────────────────────────────────────────
// `view(size)` hands us the terminal's reactive size signal; reading it inside
// the body thunk reflows the active panel on resize. The body switches screens
// on `focusKey`; the data layer feeds it through the props.
const Root = (size) => (
  <Box direction="column" width="1fr" height="1fr" padding={[0, 1]}>
    <StatusBar ifaceLabel={ifaceLabel} />
    {() => focusKey.get()
      ? <DetailPanel focusKey={focusKey} tick={tick} endpoint={endpoint} totals={totals} size={size} detailSel={detailSel} />
      : <ListPanel rows={rows} sel={sel} size={size} />}
    <Footer totals={totals} endpointCount={endpointCount} tick={tick} />
    <Legend focusKey={focusKey} />
  </Box>
);

mount(Root);

// ── keyboard navigation ───────────────────────────────────────────────────────
// Arrow keys (or j/k) move the selection; Enter opens the focused endpoint's
// detail screen; Esc (or ←/q) returns to the list. The runtime disables input
// automatically when the isolate exits, so no teardown.
tty.enableKittyKeyboard();
tty.on("keydown", (e) => {
  if (e.ctrlKey && e.code === "c") { yeet.exit(); return; }

  if (focusKey.get()) {
    if (e.code === "Escape" || e.code === "ArrowLeft" || e.key === "q") { exitDetail(); return; }
    // Move the accordion cursor between captured payloads (clamp to the count).
    const r = endpoint(focusKey.get());
    const n = r ? r.samples.length : 0;
    const move = (d) => { if (n) detailSel.set(Math.max(0, Math.min(n - 1, detailSel.get() + d))); };
    if (e.code === "ArrowDown" || e.key === "j") move(1);
    else if (e.code === "ArrowUp" || e.key === "k") move(-1);
    else if (e.code === "PageDown") move(5);
    else if (e.code === "PageUp") move(-5);
    return;
  }

  switch (e.code) {
    case "ArrowDown": moveSel(1); break;
    case "ArrowUp": moveSel(-1); break;
    case "PageDown": moveSel(10); break;
    case "PageUp": moveSel(-10); break;
    case "Enter": enterDetail(); break;
    default:
      if (e.key === "j") moveSel(1);
      else if (e.key === "k") moveSel(-1);
      else if (e.key === "q") yeet.exit();
  }
});

await new Promise(() => {}); // keep the script alive; the TUI owns the screen
