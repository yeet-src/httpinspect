// Shared BPF object. The single src/bpf/httptop.bpf.c unit is compiled and
// linked into bin/probe.bpf.o and loaded once here; the feature probe
// (httptop.js) imports this `control` and reads the `events` ring buffer.
// All binds + attaches happen before the single start(), so they live here.
//
// httptop attaches at the TC layer (TCX, ingress + egress) on every up
// interface. The TCX wildcard skips loopback, so we enumerate explicitly
// (incl. `lo`, where most local HTTP lives); `--iface a,b` narrows to named
// interfaces. This module imports only yeet:bpf — no `@/` aliases — so the
// headless self-test entry (src/verify.js, `make verify`) can import it by
// relative path and bundle it on its own.
import { BpfObject, RingBuf } from "yeet:bpf";

const wanted = yeet.args.iface
  ? new Set(String(yeet.args.iface).split(",").map((s) => s.trim()).filter(Boolean))
  : null;

let ifaces = [];
try {
  const { data, errors } = await yeet.graph.query(
    `{ network_interfaces { index name is_up } }`,
  );
  if (errors) throw new Error(errors[0].message);
  ifaces = (data.network_interfaces || []).filter((i) => i.is_up && (!wanted || wanted.has(i.name)));
} catch (err) {
  console.error(`[httptop] could not list interfaces: ${err.message}`);
  yeet.exit();
}

export const ifindexes = ifaces.map((i) => i.index);
if (ifindexes.length === 0) {
  console.error("[httptop] no matching up interfaces to watch");
  yeet.exit();
}

// What the status bar shows for the watched interfaces.
export const ifaceLabel = wanted ? ifaces.map((i) => i.name).join(",") : `all (${ifaces.length})`;

// `base: import.meta.dirname` resolves the object path against the running bundle.
const tcx = { kind: "tcx", ifindex: ifindexes };
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
