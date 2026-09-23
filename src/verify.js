// Headless correctness check for the capture + parse pipeline — no UI.
// Attaches the probe, aggregates request lines for a few seconds, and prints
// the endpoints it saw. Build + run with `make verify`: it is bundled to
// .build/verify.js so probe.js's `../bin/probe.bpf.o` resolves to bin/ exactly
// as it does for the real bundle at src/index.jsx.
//
// This is a separate entry rather than an `if (import.meta.main)` block inside
// probe.js on purpose: esbuild inlines every module into one file, so inside a
// bundle `import.meta.main` is the bundle's own and is true for every module —
// the guard would fire under `yeet run .` and replace the dashboard with this.
import { RingBuf } from "yeet:bpf";
import { control, ifindexes } from "./probes/probe.js";

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
console.log(`[verify] watching ifindexes ${ifindexes.join(",")}`);
console.log(`[verify] deduped ${dupes} loopback double-sightings`);
console.log("[verify] aggregated endpoints (count desc):");
[...stats.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, c]) => console.log(`  ${String(c).padStart(3)}  ${k}`));
await control.stop();
yeet.exit();
