import { BpfObject, RingBuf } from "yeet:bpf";

const { data } = await yeet.graph.query(`{ network_interfaces { index name is_up } }`);
const ifindexes = data.network_interfaces.filter((i) => i.is_up).map((i) => i.index);
console.log("[verify] attaching to ifindexes", ifindexes.join(","));

const probe = new BpfObject({ exe: "./bin/httptop.bpf.o", base: import.meta.dirname });
const control = await probe
  .bind("events", { kind: "ringbuf", btf_struct: "http_event" })
  .attach("on_ingress", { kind: "tcx", ifindex: ifindexes })
  .attach("on_egress", { kind: "tcx", ifindex: ifindexes })
  .start();

const REQ = /^([A-Z]+) +(\S+) +HTTP\/\d\.\d$/;
function parse(bytes) {
  let t = "";
  for (let i = 0; i < bytes.length; i++) { const c = bytes[i]; if (c === 0) break; t += String.fromCharCode(c); }
  const head = t.split("\r\n\r\n")[0];
  const lines = head.split("\r\n");
  const m = REQ.exec(lines[0] || ""); if (!m) return null;
  let host = "-";
  for (let i = 1; i < lines.length; i++) { const c = lines[i].indexOf(":"); if (c > 0 && lines[i].slice(0, c).toLowerCase() === "host") { host = lines[i].slice(c + 1).trim(); break; } }
  let path = m[2]; const q = path.indexOf("?"); if (q >= 0) path = path.slice(0, q);
  return { method: m[1], host, path };
}

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
console.log(`[verify] deduped ${dupes} loopback double-sightings`);
console.log("[verify] aggregated endpoints (count desc):");
[...stats.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, c]) => console.log(`  ${String(c).padStart(3)}  ${k}`));
await control.stop();
yeet.exit();
