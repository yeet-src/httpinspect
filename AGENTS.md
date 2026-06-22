# Building yeet dashboards

This is a **yeet** script: a reactive JSX TUI that runs in the daemon's V8
isolate, fed by live kernel data (eBPF + a process/system graph). This file
is the API contract and gotcha list for editing it. For build/run mechanics,
layout, and the `@/`/`#/` aliases, see `README.md` — don't duplicate that here.

## Mental model

It reads like React but it is **signals, not a vdom**. No hooks, no
reconciliation, no `useState`. A node re-renders exactly when a signal it
*read* changes — and the only way to "read inside a node" is to pass a
**thunk** (`() => …`) as a prop or child. A plain value is static forever; a
thunk is reactive.

```jsx
<Text>{() => `load ${load.get().toFixed(2)}`}</Text>   // re-renders on load change
<Text>{`load ${load.get()}`}</Text>                    // snapshot, never updates
```

Three layers, composed:

```
probes/  (BPF-aware)  →  signals  →  components/ (pure UI, read signals)
                          ↑
                   graph queries / timers
```

`probes/` is the *only* code that touches `yeet:bpf`; it exposes plain
signals. Components never see BPF — they read signals. `lib/` is pure helpers.

## Build bottom-up: data → component → layout

Build a dashboard from the inside out. Each layer is verifiable on its own, so
mistakes surface where they're cheap — at the data, not three layers up where a
blank panel could mean anything.

### 1. Get the data right first, in isolation

Before any JSX, confirm the kernel actually gives you the fields and types you
think it does. Guard a self-test with `import.meta.main` — it's `true` **only**
when this module is the run entry, so the block runs when you point `yeet run`
at the module and stays dormant once `main.jsx` imports it.

Verify the **raw source**, not a `from()` signal (a `from()` producer doesn't
run until something watches it — there's no UI here):

```js
// probes/conns.js
import { BpfObject, RingBuf } from "yeet:bpf";
import { from } from "yeet:tui";

const ctl = await new BpfObject({ exe: "../bin/probe.bpf.o", base: import.meta.dirname })
  .bind("events", { kind: "ringbuf", btf_struct: "conn_event" })
  .start();
const events = new RingBuf(ctl, "events");

export const conns = from((state) => { /* …wrap events into a signal… */ }, []);

// Standalone correctness probe — dumps real records so you can eyeball field
// names, the btf_struct envelope, and which numbers came back as BigInt.
if (import.meta.main) {
  await events.subscribe((w) => console.log(JSON.stringify(w, (_k, v) =>
    typeof v === "bigint" ? `${v}n` : v)));        // JSON.stringify chokes on BigInt
}
```

For a graph probe the self-test is a one-shot dump:

```js
if (import.meta.main) {
  const { data } = await yeet.graph.query(QUERY);
  console.log(JSON.stringify(data, null, 2));
  yeet.exit();
}
```

Run it directly — `yeet run src/probes/conns.js`. **Caveat:** `@/` and `#/` are
bundle-time aliases, so a standalone module must reach its siblings by relative
path (`./probe.js`), or be bundled as its own entry. Switching `JSON.stringify`
to flag BigInt up front saves you the "why does math give NaN" detour — wrap
64-bit values with `Number(...)` once you've seen them.

### 2. Build each component against a fake signal

A component is a pure function of signals, so prove it in isolation with a
hand-fed signal before any real data exists. Mount just the one:

```jsx
// scratch entry while developing components/gauge.jsx
import { mount, signal } from "yeet:tui";
import Gauge from "@/components/gauge.jsx";

const fake = signal(0.3);
setInterval(() => fake.set(Math.random()), 700);   // exercise the reactive path
mount(() => <Gauge frac={fake} label="cpu" />);
await new Promise(() => {});
```

You're checking one thing: does it repaint when the signal changes, and does it
fit its box? Get sizing and the thunk wiring right here, with data you control,
before it has to share the screen.

### 3. Layout and routing last

Only once the pieces work do you compose them. The layout is a single thunk
that reads the size signal (reflow on resize) and a view signal (which panel is
showing) — responsive breakpoints and "routing" are the same branch:

```jsx
const view = signal("cpu");
tty.on("keydown", (e) => {
  if (e.key === "1") view.set("cpu");
  else if (e.key === "2") view.set("net");
});

const Root = (size) => (
  <Box>
    <TitleBar view={view} />
    <Box height="1fr" overflow="hidden">
      {() => {
        const { cols } = size.get();
        if (cols < 80) return <Stacked view={view} />;     // responsive
        switch (view.get()) {                               // routing
          case "cpu": return <CpuPanel cpu={cpu} />;
          case "net": return <NetPanel conns={conns} />;
        }
      }}
    </Box>
    <Footer />
  </Box>
);
```

By now each panel is already known-good, so if the screen looks wrong it's the
layout math — `1fr`/`fit`/fixed and `overflow`, nothing deeper.

## Entry shape

JSX is the **automatic runtime** (`jsxImportSource: yeet:tui` in tsconfig +
esbuild) — write JSX directly, no pragma import. The entry mounts a root that
receives the terminal's reactive size signal, then parks forever:

```jsx
import { Box, Text, mount, signal } from "yeet:tui";

const Root = (size) => (
  <Box>                              {/* default direction is COLUMN, not row */}
    <Header />
    <Box height="1fr" overflow="hidden">
      {() => renderBody(size.get())} {/* reading size.get() reflows on resize */}
    </Box>
    <Footer />
  </Box>
);

mount(Root);
await new Promise(() => {}); // keep the script alive; the TUI owns the screen
```

## Signals (state) — from `yeet:tui`

```js
import { signal, computed, from } from "yeet:tui";

const n = signal(0);          n.get();  n.set(v);  n.update(x => x + 1);
const doubled = computed(() => n.get() * 2);
```

`from(producer, initial)` is **the** idiom for turning a subscription or poll
into a signal — the producer runs when the signal is first watched and its
cleanup runs when no one watches, so the kernel work is tied to the UI:

```js
export const cpus = from((state) => {
  const sub = events.subscribe(w => { /* accumulate */ });
  const h = setInterval(() => state.set(snapshot()), 500); // publish a window
  return () => { clearInterval(h); sub.then(s => s.unsubscribe()); };
}, initialValue);
```

**Never `.set()` during a render/computed eval** — defer with `setInterval`,
a subscription callback, or `Promise.resolve().then(() => sig.set(…))`.

## Components — `yeet:tui`

- `Box(opts, ...kids)` — flow container. `direction="row"|"column"` (**column
  default**). `width/height/left/top/right/bottom`, `border`, `padding`,
  `overflow="hidden"|"visible"`, `z`, `bg`.
- `Layer(opts, ...kids)` — z-stack; child insets are absolute in the rect.
- `Text(opts, content)` — `break="word"|"anywhere"|"none"`,
  `overflow="hidden"|"ellipsis"|"visible"`.
- `CellBuffer({rows, cols})` — raster surface: `.blit(x,y,str)`,
  `.tint(x,y,w,h,color)`, `.clear()` for pixel/game drawing.
- `Effect(fn)` — invisible lifecycle leaf; `fn` runs on mount, returns teardown.

**Sizing** — every dimension is a `Size`, accepted as a string or via the
`Size` helper: `"1fr"` (flex weight), `"10"`/`Size.fixed(10)`, `"50%"`,
`"fit"`, `"50vw"`, `Size.min/max/clamp/add/sub(...)`. **Frame the root with
`1fr` or a fixed size or the tree collapses to 0.**

**Color & faces** — combinators wrap a string (innermost wins):
`fg(color)`, `bg(color)`, `bold`, `dim`, `italic`, `underline`, `reverse`,
`strike`. Colors: `idx(0..255)`, `rgb(0xRRGGBB)` / `rgb(r,g,b)`,
`rgba(...,a)`, `color("#ff0080")`, `DEFAULT`.

```jsx
<Text>{() => bold(fg(idx(2))(`${pct(frac.get())}`))}</Text>
```

(There's also a separate `style.red(s)` / `style.bold(s)` global — that's for
raw `tty.write` line-mode tools, *not* the JSX tree. Use face combinators here.)

## Data sources

**Graph** — process/system state as GraphQL:

```js
const { data } = await yeet.graph.query(`{ procs { stat { pid comm rss_bytes } } }`);
// streaming: import { subscribe } from "yeet:graph"
```

⚠️ **Race big queries against a timeout.** A pathological query (e.g. full
memory maps of a huge process) can wedge the daemon for *all* runs until it's
restarted.

**BPF** — bind maps on the shared object, then read them (`yeet:bpf`):

```js
import { BpfObject, RingBuf, ArrayMap, HashMap, DataSec } from "yeet:bpf";

const ctl = await new BpfObject({ exe: "../bin/probe.bpf.o", base: import.meta.dirname })
  .bind("events", { kind: "ringbuf", btf_struct: "sched_event" })
  .bind("probe.data", { kind: "data" })   // .data/.rodata/.bss section
  .bind("runq_hist", { kind: "array" })
  .start();                                // probes auto-attach

const events = new RingBuf(ctl, "events");
await events.subscribe(w => {
  const e = w?.sched_event ?? w;           // ⚠️ event is WRAPPED under btf_struct name
  // e.cpu, e.prev_comm, e.slice_ns, …
});

const hist = new ArrayMap(ctl, "runq_hist");   // poll: await hist.lookup(i)
const knobs = new DataSec(ctl, "probe.data");  // write: knobs.patch({ field: … })
```

`kind` values: `ringbuf`, `hash-map`, `lru-hash-map`, `array`, `percpu-*`,
`lpm-trie`, `bloom-filter`, `data`. In `.bind()`, **every key except `kind` is
a top-level option** (`btf_struct`, `capacity`, …) — nesting under `opts`
fails silently. Map methods: `lookup/update/delete/entries/lookupBatch` (hash),
`lookup/update` (array), `read/patch` (data-sec), per-CPU lookups return an
array per CPU.

## Input — global `tty`

```js
tty.enableMouse();
tty.on("keydown", e => {                  // {code, key, ctrlKey, shiftKey, altKey, repeat, preventDefault()}
  const k = (e.key ?? "").toLowerCase();
  if (e.code === "Escape" || k === "q") return yeet.exit();
  if (e.code === "ArrowDown" || k === "j") move(1);
});
tty.on("wheel",     e => move(e.deltaY > 0 ? 3 : -3));   // {deltaX, deltaY, clientX, clientY}
tty.on("mousedown", e => { if (e.button === 0) select(e.clientY); }); // {button, clientX, clientY}
tty.on("resize",    s => viewport.set(s));               // {rows, cols}
```

Coordinates are 0-indexed. `tty.size()` → `{rows, cols}`. `e.preventDefault()`
suppresses the Ctrl-C kill / Ctrl-D detach defaults. `tty.frame(cb)` batches
writes atomically. `yeet.exit()` tears the script down.

## Composition patterns

- **Responsive layout** — derive breakpoints from a size computed, branch in a
  thunk: `{() => columns.get() === 1 ? <Narrow/> : <Wide/>}`.
- **Sparkline / bars** — `"▁▂▃▄▅▆▇█"[Math.min(7, Math.floor(v/peak*7.99))]`.
- **Fill / background** — a Box's `bg` prop tints its whole rect (color or
  `(x,y,w,h) => color` shader). Don't paint spaces — `wrap` trims them; if you
  must fill with *text*, use non-breaking spaces.
- **Proportional gauge** — two `Box`es with computed `1fr` widths that sum to a
  constant, each `bg`-filled (see the worked example).
- **Color-by-value** — `const heat = f => f < 0.6 ? GREEN : f < 0.85 ? AMBER : RED`.
- **Table** — fixed `Text` header + `{() => rows.get().slice(0, h).map(r => <Text>{cells(r)}</Text>)}`.
- **Rate** — accumulate in a window, `setInterval(1000)` pushes to a bounded
  history array signal and resets the window.

## Gotchas that bite

1. **No `Intl`, no `TextDecoder`/`TextEncoder`** — `localeCompare`,
   `toLocaleString`, `Intl.*` all throw. Hand-roll formatting; decode `comm`
   byte arrays with a `String.fromCharCode` loop, stopping at the first `\0`.
2. **64-bit map fields need `BigInt`** — `knobs.patch({ x: BigInt(n) })`;
   smaller ints take plain numbers. Ring-buffer `__u64` fields arrive as
   `BigInt` — `Number(e.slice_ns)` to use them in math.
3. **Set-during-render throws** — defer signal writes out of the render path.
4. **`column` is the default Box direction** (Yoga, not CSS) — set
   `direction="row"` explicitly for horizontal.
5. **Use `fg`/`bg`/`bold`** in the tree — never `color`/`style`/`backgroundColor`.
6. **Ring-buffer events are wrapped** under the `btf_struct` name — unwrap with
   `w?.<struct> ?? w`.
7. **`@/` and `#/` are bundle-time only** — the runtime resolver doesn't know
   them, which is why the BPF object is located with `import.meta.dirname`.
8. **`console.log` goes to the daemon log, not the screen** (and strips ANSI) —
   render in-pane via the JSX tree or `tty.write`.
9. **No Node builtins** (`fs`, `net`, …) — only packages that run in bare V8
   bundle cleanly.
10. **Don't `.set()` per high-rate event** — a busy ring buffer fires thousands
    of times a second; accumulate in a plain variable and publish a snapshot on
    a `setInterval` window (250–1000 ms). One re-render per frame, not per event.
11. **Guard the pre-data state** — signals start at their initial value (often
    `null`/`[]`), so every render thunk runs once before data arrives. Use
    `x?.field` / `if (!data) return …` or the first frame throws.
12. **Uncaught errors get dumped over your UI** — there's no `unhandledrejection`
    hook; the daemon renders the exception to the screen. Catch at the
    boundaries (see *Crash handling*) so a failing probe degrades to a status
    line instead of wrecking the display.
13. **`yeet.args` is minimist-parsed** — positionals in `yeet.args._`, flags as
    named keys (`yeet run . -- --pid 42 eth0` → `{_: ["eth0"], pid: 42}`). Use
    it to parameterize a dashboard (target pid, interface, refresh rate).

## Worked examples

### A complete component (pure UI, reads a signal)

A horizontal gauge. It takes a `frac` signal and paints a heat-colored fill
against a rail, with a percentage on the right. A Box's `bg` prop **tints its
whole rect** — that's how you fill (don't paint a string of spaces; `wrap`
trims trailing ones, and filling with *text* would need non-breaking spaces).
Two boxes whose `fr` weights sum to a constant make a proportional bar; both
widths read `frac`, so each fill is a thunk child that re-mints its Box when
`frac` changes — only those parts re-render.

```jsx
// components/gauge.jsx
import { Box, Text, bold, fg, idx } from "yeet:tui";

const RAIL = idx(238);
const heat = (f) => (f < 0.6 ? idx(2) : f < 0.85 ? idx(3) : idx(1));
const pct = (f) => `${Math.round(f * 100)}%`;
const lpad = (s, n) => `${s}`.padStart(n);

export default function Gauge({ frac, label }) {
  return (
    <Box height="1" direction="row">
      <Text width="8">{fg(idx(244))(label)}</Text>
      {() => <Box width={`${1 + Math.round(frac.get() * 998)}fr`} bg={heat(frac.get())} />}
      {() => <Box width={`${1 + Math.round((1 - frac.get()) * 998)}fr`} bg={RAIL} />}
      <Text width="5">{() => bold(lpad(pct(frac.get()), 5))}</Text>
    </Box>
  );
}
```

### A complete probe (kernel → signal, polled graph)

No BPF needed — poll the system graph on a timer and expose a `cpu` fraction
signal. `from()` ties the timer's lifecycle to the UI watching it.

```js
// probes/sysload.js
import { computed, from } from "yeet:tui";

// Whole-host CPU busy fraction, sampled once a second from the kernel graph.
const QUERY = `{ kernel_stats { total { user nice system irq softirq idle iowait } } }`;
const busy = (t) => t.user + t.nice + t.system + t.irq + t.softirq;
const total = (t) => busy(t) + t.idle + t.iowait;

export const cpu = from((state) => {
  let prev = null;
  const tick = async () => {
    const { data } = await yeet.graph.query(QUERY);
    const t = data.kernel_stats.total;
    if (prev) {
      const db = busy(t) - busy(prev);
      const dt = total(t) - total(prev);
      state.set(dt > 0 ? db / dt : 0);    // delta between samples, not absolute
    }
    prev = t;
  };
  const h = setInterval(() => tick().catch(() => {}), 1000);
  tick().catch(() => {});
  return () => clearInterval(h);
}, 0);

export const cpuPct = computed(() => Math.round(cpu.get() * 100));
```

### Wiring it together

```jsx
// main.jsx
import { Box, Text, bold, mount } from "yeet:tui";
import { cpu } from "@/probes/sysload.js";
import Gauge from "@/components/gauge.jsx";

tty.on("keydown", (e) => {
  if (e.code === "Escape" || (e.key ?? "").toLowerCase() === "q") yeet.exit();
});

const Root = () => (
  <Box>
    <Text height="1">{bold(" sysload  —  q to quit")}</Text>
    <Box height="1fr" overflow="hidden">
      <Gauge frac={cpu} label="cpu" />
    </Box>
  </Box>
);

mount(Root);
await new Promise(() => {});
```

### Live BPF feed → scrolling list

The starter's `cpusched` is the full version; this is the minimal shape — a
ring-buffer subscription pushed into a bounded list signal that a component
renders.

```js
// probes/conns.js
import { BpfObject, RingBuf } from "yeet:bpf";
import { from } from "yeet:tui";

const MAX = 50;

export const conns = from((state) => {
  const rows = [];
  const ctl = new BpfObject({ exe: "../bin/probe.bpf.o", base: import.meta.dirname })
    .bind("events", { kind: "ringbuf", btf_struct: "conn_event" });
  const sub = ctl.start().then((c) =>
    new RingBuf(c, "events").subscribe((w) => {
      const e = w?.conn_event ?? w;                 // unwrap the btf_struct envelope
      rows.unshift({ comm: e.comm, port: e.dport });
      if (rows.length > MAX) rows.pop();
      state.set(rows.slice());                      // publish a fresh array → re-render
    }),
  );
  return () => sub.then((s) => s.unsubscribe());
}, []);
```

```jsx
// components/conns.jsx — reads the signal in a thunk, one Text per row
import { Box, Text } from "yeet:tui";

export default function Conns({ conns }) {
  return (
    <Box height="1fr" overflow="hidden">
      {() => conns.get().map((r) => <Text height="1">{`${r.comm.padEnd(16)} :${r.port}`}</Text>)}
    </Box>
  );
}
```

## More BPF patterns

### Effect-scoped subscription (a "BPF effect")

`from()` ties a subscription to *a signal* being watched. `Effect` ties one to
*a subtree being mounted* — so an expensive probe runs only while its panel is
on screen and tears down when you navigate away. The `Effect` re-runs whenever
a signal it reads changes, so it also re-targets cleanly.

```jsx
// components/detail.jsx — subscribe only while this panel is visible
import { Box, Effect, Text, signal } from "yeet:tui";
import { RingBuf } from "yeet:bpf";
import { control } from "@/probes/probe.js";

export default function Detail({ pid }) {
  const lines = signal([]);
  return (
    <Box height="1fr" overflow="hidden">
      <Effect>
        {() => {
          const target = pid.get();                 // read → re-runs when pid changes
          const rb = new RingBuf(control, "syscalls");
          const sub = rb.subscribe((w) => {
            const e = w?.syscall_event ?? w;
            if (e.pid !== target) return;
            lines.set([e.name, ...lines.get()].slice(0, 200));
          });
          return () => sub.then((s) => s.unsubscribe()); // teardown on unmount / re-run
        }}
      </Effect>
      {() => lines.get().map((l) => <Text height="1">{l}</Text>)}
    </Box>
  );
}
```

`Effect`'s teardown accepts a function or a `{ unsubscribe }`. Its reads do
**not** become render dependencies of the surrounding tree — it has its own
lifecycle. An `Effect` leaf is invisible and zero-sized, so drop it anywhere.

### user → kernel: a live knob (DataSec.patch)

JS only sees events the kernel emits — push a filter *into* the program by
patching a global in its `.data` section. 64-bit fields want a `BigInt`.

```js
// probes/knob.js
import { DataSec } from "yeet:bpf";
import { signal } from "yeet:tui";
import { control } from "@/probes/probe.js";

const knobs = new DataSec(control, "probe.data");

export const minSliceUs = signal(1000);             // mirror the compiled default

export function setMinSlice(us) {
  us = Math.max(0, us);
  minSliceUs.set(us);                               // UI reads this
  knobs.patch({ min_slice_ns: BigInt(us * 1000) }); // kernel re-filters live
}
// read the whole section back with knobs.read(), or one field: knobs.read("min_slice_ns")
```

```js
// in main.jsx input handler
if (k === "+") setMinSlice(minSliceUs.get() + 100);
if (k === "-") setMinSlice(minSliceUs.get() - 100);
```

### HashMap aggregation → top-N table

Poll a hash map on a timer, iterate, sort, publish. `entries()` pages
transparently; iteration order is unstable under churn, so collect-then-act.

```js
// probes/syscount.js — map keyed by comm[16], value is a __u64 counter
import { HashMap } from "yeet:bpf";
import { from } from "yeet:tui";
import { control } from "@/probes/probe.js";

const counts = new HashMap(control, "counts");
const comm = (u8) => { let s = ""; for (const b of u8) { if (!b) break; s += String.fromCharCode(b); } return s; };

export const top = from((state) => {
  const h = setInterval(async () => {
    const rows = [];
    for await (const [k, v] of counts.entries()) rows.push({ comm: comm(k.comm), n: Number(v) });
    rows.sort((a, b) => b.n - a.n);
    state.set(rows.slice(0, 20));
  }, 1000);
  return () => clearInterval(h);
}, []);

// per-CPU counter map? lookup → array per CPU; sum with BigInt:
//   const total = (await pcMap.lookup(key)).reduce((a, b) => a + b, 0n);
```

### Polled histogram → log2 bar chart

The other egress: the kernel aggregates into an array map, JS just reads slots.

```jsx
// components/histogram.jsx — `latency` is a signal of per-bucket counts
import { Box, Text, fg, idx } from "yeet:tui";

const BARS = "▁▂▃▄▅▆▇█";
const lo = (i) => (i === 0 ? 0 : 1 << (i - 1));     // log2 bucket lower bound (ns)

export default function Histogram({ latency }) {
  return (
    <Box height="1fr" overflow="hidden">
      {() => {
        const slots = latency.get();
        const peak = Math.max(...slots, 1);
        return slots.map((n, i) => (
          <Text height="1">
            {`${String(lo(i)).padStart(12)}ns `}
            {fg(idx(4))(BARS[Math.min(7, Math.floor((n / peak) * 7.99))].repeat(Math.ceil((n / peak) * 40)))}
            {`  ${n}`}
          </Text>
        ));
      }}
    </Box>
  );
}
```

(The probe side is `runqlat.js` in the starter: `ArrayMap.lookup(i)` per slot
on a timer, published through `from()`.)

## Crash handling (a BSOD)

There's no global `unhandledrejection`/`onerror` hook in JS — when something
throws uncaught, the daemon paints the raw exception over your screen. That's
ugly and loses the alt-screen/cursor state. Better to catch at the two
boundaries you control and show your own crash screen.

**Boundary 1 — async probe failures degrade to a status line.** A probe that
can't load (missing BTF, no root, bad bind) should set an error signal, not
reject into the void:

```js
export const status = signal("starting…");

export const start = async () => {
  try {
    const ctl = await new BpfObject({ exe: "../bin/probe.bpf.o", base: import.meta.dirname })
      .bind("events", { kind: "ringbuf", btf_struct: "conn_event" })
      .start();
    /* … wire maps … */
    status.set("tracing");
  } catch (e) {
    status.set(`probe failed: ${e.message ?? e}`);   // UI shows this, app stays up
  }
};
```

**Boundary 2 — wrap `mount` so a setup throw shows a BSOD instead of a stack
dump.** `mount` owns the alt screen and cursor; re-mounting a crash component
keeps that lifecycle clean:

```jsx
// main.jsx
import { mount } from "yeet:tui";
import App from "@/components/app.jsx";
import Bsod from "@/components/bsod.jsx";

tty.on("keydown", (e) => {
  if (e.code === "Escape" || (e.key ?? "").toLowerCase() === "q") yeet.exit();
});

try {
  mount(App);
} catch (e) {
  mount(() => <Bsod error={e} />);   // any key still quits via the handler above
}
await new Promise(() => {});
```

The crash screen itself is just a `bg`-filled box — no special API:

```jsx
// components/bsod.jsx
import { Box, Text, bold, fg, idx } from "yeet:tui";

const BLUE = idx(20);
const WHITE = idx(15);

export default function Bsod({ error }) {
  const lines = String(error?.stack ?? error?.message ?? error).split("\n");
  return (
    <Box bg={BLUE} width="1fr" height="1fr" padding={2}>
      <Text height="1">{bold(fg(WHITE)(":(  your dashboard hit an error"))}</Text>
      <Text height="1">{" "}</Text>
      {lines.map((l) => <Text height="1">{fg(WHITE)(l)}</Text>)}
      <Text height="1">{" "}</Text>
      <Text height="1">{fg(idx(250))("press q to quit")}</Text>
    </Box>
  );
}
```

Note this only catches *synchronous* setup errors. Errors thrown later inside a
render thunk (e.g. reading a field off a `null` signal — gotcha 11) happen
during a re-render that `try/catch` can't wrap, which is exactly why you guard
the pre-data state at the source instead.

## System info

`system.numCpus`, `system.arch`, `system.os`, `system.kernel`
(`{major, minor, patch}`), `system.endianness`. `setTimeout`/`setInterval`/
`clearInterval`/`queueMicrotask` are available.
