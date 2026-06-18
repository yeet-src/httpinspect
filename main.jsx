// SPDX-License-Identifier: GPL-2.0
// httptop — a live dashboard of the most active plaintext HTTP endpoints on
// this host. An eBPF program at the TC layer ships HTTP request lines to JS;
// state.js parses method + Host + path and aggregates by endpoint, and
// dashboard.js renders a sorted, auto-refreshing table.
//
//   yeet run .                 # watch every up interface (incl. loopback)
//   yeet run . --iface lo,eth0 # only these interfaces
//   yeet run . --keep-query    # don't collapse the query string into the path
//
// Plaintext HTTP only — HTTPS payloads are ciphertext at this layer.

import { RingBuf } from "yeet:bpf";
import { mount } from "yeet:tui";
import bpf from "./bin/httptop.bpf.o";

import { onEvent, startTicks, info, moveSel, enterDetail, exitDetail, focusKey } from "./state.js";
import { Dashboard } from "./dashboard.jsx";

// The TUI needs a real terminal: in non-TTY mode (piped/redirected output)
// yeet never installs the `tty` global, and `mount`'s `term = tty` default
// would throw a bare `ReferenceError: tty is not defined` with no output.
// Fail loudly instead.
if (typeof tty === "undefined") {
  console.error("[httptop] needs an interactive terminal — don't pipe or redirect output (and avoid --no-tty).");
  yeet.exit();
}

// Which interfaces to watch. The TCX wildcard skips loopback, so we always
// enumerate every up interface explicitly (incl. `lo`) — that's where most
// local HTTP lives. `--iface a,b` narrows to named interfaces.
const wanted = yeet.args.iface
  ? new Set(String(yeet.args.iface).split(",").map((s) => s.trim()).filter(Boolean))
  : null;

let ifaces = [];
try {
  const { data, errors } = await yeet.graph.query(
    `{ network_interfaces { index name is_up } }`
  );
  if (errors) throw new Error(errors[0].message);
  ifaces = (data.network_interfaces || [])
    .filter((i) => i.is_up && (!wanted || wanted.has(i.name)));
} catch (err) {
  console.error(`[httptop] could not list interfaces: ${err.message}`);
  yeet.exit();
}
const ifindexes = ifaces.map((i) => i.index);
if (ifindexes.length === 0) {
  console.error("[httptop] no matching up interfaces to watch");
  yeet.exit();
}
info.ifaceLabel = wanted ? ifaces.map((i) => i.name).join(",") : `all (${ifaces.length})`;

// ── load + attach the probe ────────────────────────────────────────────────
const tcxSpec = { kind: "tcx", ifindex: ifindexes };
let control;
try {
  control = await bpf
    .bind("events", { kind: "ringbuf", btf_struct: "http_event" })
    .attach("on_ingress", tcxSpec)
    .attach("on_egress", tcxSpec)
    .start();
} catch (err) {
  console.error(`[httptop] failed to load eBPF: ${err.message}`);
  console.error("[httptop] need CAP_BPF/root and a compiled bin/httptop.bpf.o (run `make`).");
  yeet.exit();
}

new RingBuf(control, "events").subscribe(
  onEvent,
  (err) => console.error("[httptop] ringbuf error:", err.message),
);

startTicks();
mount(Dashboard);

// ── keyboard navigation ─────────────────────────────────────────────────────
// Arrow keys (or j/k) move the selection in the list; Enter opens the focused
// endpoint's detail screen; Esc (or ←/q) returns to the list. The runtime
// disables input automatically when the isolate exits, so no teardown.
tty.enableKittyKeyboard();
tty.on("keydown", (e) => {
  if (e.ctrlKey && e.code === "c") { yeet.exit(); return; }

  if (focusKey.get()) {
    if (e.code === "Escape" || e.code === "ArrowLeft" || e.key === "q") exitDetail();
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

await new Promise(() => {}); // run until Ctrl-C
