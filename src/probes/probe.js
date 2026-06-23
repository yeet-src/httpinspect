// Shared BPF object. The single src/bpf/httptop.bpf.c unit is compiled and
// linked into bin/probe.bpf.o and loaded once here; the feature probe
// (httptop.js) imports this `control` and reads the `events` ring buffer.
// All binds + attaches happen before the single start(), so they live here.
//
// httptop attaches at the TC layer (TCX, ingress + egress). By default we hand
// the daemon a *wildcard* (omit `ifindex`): it enumerates and attaches every
// supported host interface itself. The wildcard path skips loopback (TCX attach
// EINVALs on `lo`), so the 127.0.0.1 leg is NOT captured in that mode — pass
// `--iface a,b` to switch to an explicit ifindex list (which keeps `lo`)
// narrowed to the named interfaces. Wildcard also only covers the host netns;
// interfaces inside other netns (e.g. ECS awsvpc task ENIs) are not reached
// from a host daemon. This module imports only yeet:bpf — no `@/` aliases — so
// it stays runnable on its own for the import.meta.main self-test below.
import { BpfObject, RingBuf } from "yeet:bpf";

const wanted = yeet.args.iface
  ? new Set(String(yeet.args.iface).split(",").map((s) => s.trim()).filter(Boolean))
  : null;

// The TCX attach spec. No --iface → wildcard (omit `ifindex`): the daemon
// enumerates and attaches every supported host interface. --iface a,b → an
// explicit ifindex list, resolved from the graph and narrowed to those names
// (this path keeps `lo`, which the wildcard path drops).
let tcx;
let ifaceLabel;
if (wanted) {
  let ifaces = [];
  try {
    const { data, errors } = await yeet.graph.query(
      `{ network_interfaces { index name is_up } }`,
    );
    if (errors) throw new Error(errors[0].message);
    ifaces = (data.network_interfaces || []).filter((i) => i.is_up && wanted.has(i.name));
  } catch (err) {
    console.error(`[httptop] could not list interfaces: ${err.message}`);
    yeet.exit();
  }
  const ifindexes = ifaces.map((i) => i.index);
  if (ifindexes.length === 0) {
    console.error("[httptop] no matching up interfaces to watch");
    yeet.exit();
  }
  tcx = { kind: "tcx", ifindex: ifindexes };
  ifaceLabel = ifaces.map((i) => i.name).join(",");
} else {
  tcx = { kind: "tcx" }; // wildcard — daemon attaches to every supported iface
  ifaceLabel = "all (wildcard)";
}

// What the status bar shows for the watched interfaces.
export { ifaceLabel };

// `base: import.meta.dirname` resolves the object path against the running bundle.
const probe = new BpfObject({ exe: "../bin/probe.bpf.o", base: import.meta.dirname });

export const control = await (async () => {
  try {
    return await probe
      .bind("events", { kind: "ringbuf", btf_struct: "http_event" })
      .attach("on_ingress", tcx)
      .attach("on_egress", tcx)
      .start();
  } catch (err) {
    console.error(`[httptop] failed to load eBPF: ${err.message}`);
    console.error("[httptop] need CAP_BPF/root and a compiled bin/probe.bpf.o (run `make`).");
    yeet.exit();
  }
})();

// Standalone correctness probe — `yeet run src/probes/probe.js` dumps the
// endpoints it aggregates over a few seconds, so you can eyeball that the
// kernel filter, the btf_struct envelope, and the loopback dedup all behave
// before any UI exists. Dormant once httptop.js imports `control`.
if (import.meta.main) {
  const REQ = /^([A-Z]+) +(\S+) +HTTP\/\d\.\d$/;
  const parse = (bytes) => {
    let t = "";
    for (let i = 0; i < bytes.length; i++) { const c = bytes[i]; if (c === 0) break; t += String.fromCharCode(c); }
    const lines = t.split("\r\n\r\n")[0].split("\r\n");
    const m = REQ.exec(lines[0] || "");
    if (!m) return null;
    let host = "-";
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].indexOf(":");
      if (c > 0 && lines[i].slice(0, c).toLowerCase() === "host") { host = lines[i].slice(c + 1).trim(); break; }
    }
    let path = m[2]; const q = path.indexOf("?"); if (q >= 0) path = path.slice(0, q);
    return { method: m[1], host, path };
  };

  const stats = new Map();
  const seen = new Set();
  let dupes = 0;
  await new RingBuf(control, "events").subscribe((raw) => {
    const ev = raw.http_event ?? raw;
    const k = `${ev.family}:${ev.sport}>${ev.dport}#${ev.seq}`;
    if (seen.has(k)) { dupes++; return; }
    seen.add(k);
    const d = ev.data instanceof Uint8Array ? ev.data : Uint8Array.from(Object.values(ev.data));
    const r = parse(d.subarray(0, Number(ev.captured)));
    if (!r) return;
    const key = `${r.method} ${r.host} ${r.path}`;
    stats.set(key, (stats.get(key) || 0) + 1);
  });

  await new Promise((r) => setTimeout(r, 4500));
  console.log(`[verify] watching ${ifaceLabel}`);
  console.log(`[verify] deduped ${dupes} loopback double-sightings`);
  console.log("[verify] aggregated endpoints (count desc):");
  [...stats.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, c]) => console.log(`  ${String(c).padStart(3)}  ${k}`));
  await control.stop();
  yeet.exit();
}
