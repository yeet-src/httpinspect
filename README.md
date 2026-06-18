# `httpinspect`

> **`top` for the HTTP endpoints on your host.** Every plaintext HTTP request crossing the box — decoded off the wire and ranked live in your terminal by traffic, rate, and latency. No proxy, no sidecar, no app changes.

<p align="center">
  <img src="https://img.shields.io/badge/platform-Linux-1793D1" alt="Linux">
  <img src="https://img.shields.io/badge/built%20with-yeet%20%2B%20eBPF-8A2BE2" alt="yeet + eBPF">
  <img src="https://img.shields.io/badge/license-GPL--2.0-3DA639" alt="GPL-2.0">
  <a href="https://discord.gg/dYZu9PjKB"><img src="https://img.shields.io/badge/chat-Discord-5865F2" alt="Discord"></a>
</p>

<p align="center">
  <img src="assets/http-endpoint.gif" alt="httpinspect — a live HTTP endpoint dashboard in the terminal" width="820">
</p>

**`httpinspect` turns the HTTP requests crossing your host into a live `top`-style table** — every endpoint sorted by traffic, with a running request count, a per-second rate, and how long ago each was last hit. Open one and you get a focused detail screen: on-the-wire latency (p50 / p95 / max), status-code mix, and req/s and latency sparklines — all built on eBPF, all reading the bytes straight off the wire.

> [!TIP]
> **No proxy, no port to point at, no app changes.** `httpinspect` attaches eBPF programs at the TC layer and reads HTTP request lines straight off the wire as packets flow through the kernel — including loopback, so requests between local services are covered too. Your traffic is never intercepted, held, or delayed.

## Quick start

```sh
curl -fsSL https://yeet.cx | sh
make            # compile bin/httptop.bpf.o (needs clang + bpftool)
yeet run .      # watch every up interface, including loopback
```
[Manual install guide](https://yeet.cx/docs/manual-installation) | Linux only

With any plaintext HTTP flowing on the box, that's it — `httpinspect` enumerates the up interfaces, attaches at the TC layer, and starts ranking endpoints. Flags tune what it watches and how it groups:

| flag             | default       | meaning                                                              |
| ---------------- | ------------- | -------------------------------------------------------------------- |
| `--iface=<list>` | all up ifaces | comma-separated interface names to watch, e.g. `--iface=lo,eth0`     |
| `--keep-query`   | off           | keep query strings distinct — `/x?id=1` and `/x?id=2` stay separate rows instead of collapsing into one |

```sh
yeet run . --iface lo,eth0   # only these interfaces
yeet run . --keep-query      # /x?id=1 and /x?id=2 stay separate rows
```

Runs until `Ctrl-C`. Resize the terminal and the table reflows; needs a real terminal (it's a TUI — don't pipe or redirect the output).

## A 30-second primer on HTTP-on-the-wire

The mental model for what `httpinspect` reads:

**A request is text.** An HTTP/1.x request starts with a request line — `GET /path HTTP/1.1` — followed by headers, one per line, then a blank line. The very first bytes of the TCP payload *are* that line.

**The endpoint is `METHOD host path`.** The method and path come from the request line; the host comes from the `Host:` header (or the absolute-form target on a proxied/`CONNECT` request). `httpinspect` tallies traffic by that triple.

**Plaintext only.** This works because the bytes on the wire *are* the request. Under TLS (`https://`) the payload is ciphertext at this layer, so HTTPS is invisible — see the caveats.

## Common use cases

`httpinspect` is for anyone who wants a ground-truth picture of the plaintext HTTP actually crossing a host — not what an app's own access log claims it served.

- A service is slow. Which endpoint is getting hammered, and at what rate?
- You suspect a retry storm. Watch a path's `REQ/S` spike in real time.
- Auditing a box: what plaintext HTTP is actually flowing, and to which hosts?
- Local microservices talking over `lo` — see the chatter without instrumenting any of them.

## What you're looking at

```
httpinspect · watching all (3) · plaintext HTTP only
 #  METHOD  HOST            PATH              COUNT   REQ/S   LAST
 1  GET     shop.internal   /api/products      1843    27     0s
 2  POST    auth.internal   /login              512     4      1s
 3  GET     shop.internal   /health             318     ·      3s
```

A **status bar** names the app, the interfaces being watched, and a reminder that this is plaintext HTTP only. The **table** is one row per `METHOD host path` endpoint, sorted by total count (busiest first), capped to what fits the terminal. The **footer** carries total requests, distinct endpoints, total bytes seen on the wire, and uptime.

| column   | meaning                                                          |
| -------- | --------------------------------------------------------------- |
| `#`      | rank by total count                                             |
| `METHOD` | HTTP method, color-coded (GET, POST, PUT, …)                    |
| `HOST`   | `Host:` header (or authority from an absolute-form target)      |
| `PATH`   | request path; query string collapsed unless `--keep-query`      |
| `COUNT`  | cumulative requests seen for this endpoint                      |
| `REQ/S`  | requests in the last second (`·` when idle)                     |
| `LAST`   | how long ago this endpoint was last hit                         |

Colors come from yeet's terminal styling and no-op to plain text when stdout isn't a TTY — but `httpinspect` is a TUI and needs a real terminal, so it refuses to run piped or redirected rather than render garbage.

## Navigation

The dashboard is interactive:

| key                        | action                                              |
| -------------------------- | --------------------------------------------------- |
| `↑` / `↓` (or `k` / `j`)   | move the selection up/down the endpoint list        |
| `PgUp` / `PgDn`            | jump ten rows                                       |
| `Enter`                    | open the **detail screen** for the highlighted endpoint |
| `Esc` (or `←`)             | return to the list                                  |
| `q`                        | back to the list (in detail) / quit (in the list)   |
| `Ctrl-C`                   | quit                                                |

The **detail screen** is a focused, live breakdown of one `METHOD host path` endpoint:

- total requests and its share of all traffic, current and peak req/s
- **latency** (p50 / p95 / max) — derived by pairing each response with its request on the wire (see below)
- **status codes** seen, color-coded by class (2xx/3xx/4xx/5xx)
- bytes on the wire, first/last-seen ages
- block sparklines of req/s and of recent response latency

It updates in place as new traffic arrives — no need to back out and re-enter.

## How it works

The core is in [`httptop.bpf.c`](httptop.bpf.c) and the JS rendering layer rooted at [`main.jsx`](main.jsx).

### The BPF side

A single BPF object attaches two TC (`tcx`) programs, auto-attached on `start()` by their `SEC()` names, and ships decoded events to userspace over a ring buffer:

| program      | hook           | what it captures                                                       |
| ------------ | -------------- | ---------------------------------------------------------------------- |
| `on_ingress` | `tcx/ingress`  | inbound TCP segments — requests arriving / responses returning         |
| `on_egress`  | `tcx/egress`   | outbound TCP segments — requests this host sends / responses it serves |

For each segment the program does a cheap in-kernel check on the first payload bytes: does it begin with an HTTP method token (`GET `, `POST `, …) — a **request** — or with `HTTP/` — a **response** status line? Only those two cross the ring buffer (responses capped short, since only the status line is needed); ACKs and non-HTTP traffic are dropped in the kernel. Every event carries a monotonic kernel timestamp.

The one map connecting kernel to userspace is `events` — a `RINGBUF` bound by its `btf_struct` (`http_event`), one decoded record per captured segment.

### The JS side

The dashboard runs in yeet's V8 runtime, subscribing to that ring buffer and rendering the terminal UI with `yeet:tui`:

| file            | responsibility                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `main.jsx`      | entry: tty guard, interface discovery, BPF attach, ringbuf subscribe, mount, key input          |
| `state.js`      | live data + request/response ingest, latency pairing, status tally, rate ticks, selection       |
| `render.jsx`    | formatters, method colors, column widths, sparkline (pure)                                      |
| `dashboard.jsx` | panels + layout: the list and endpoint-detail screens (the Dashboard view)                      |

In userspace, each response is paired with the oldest unmatched request on the same flow — the unordered port pair, since a response travels the reverse direction. The timestamp delta is the **on-the-wire latency**, and the status line gives the **code**; both are aggregated per endpoint.

### Why TC, not a proxy or a syscall wrapper

Reading requests at the TC layer means there's nothing to point traffic through and no app to reconfigure — the programs observe and copy request segments as the kernel moves them, including loopback, so local service-to-service chatter is covered without instrumenting anything. And because the method/`HTTP/` check happens in the kernel, ACKs and non-HTTP traffic never cost a ring-buffer write.

## Requirements

> [!IMPORTANT]
> Linux with **BTF** (`CONFIG_DEBUG_INFO_BTF=y`) — needed for the TC context structs and the `sock` types the programs read. Default on current Arch, Fedora, Ubuntu, and Debian 12+. CO-RE means no per-kernel recompile.
>
> A reasonably recent kernel with **TCX** support (`tcx` links, Linux 6.6+), plus the yeet daemon, which handles the privileged BPF load. `curl -fsSL https://yeet.cx | sh` installs it.

## Honest caveats

> [!NOTE]
> `httpinspect` is observability, not enforcement. It tells you what crossed the wire; it does not stop, hold, or modify anything.

- **Plaintext HTTP only.** TLS payloads are ciphertext at this layer, so HTTPS is invisible. Capturing it would need a uprobe on `SSL_write`/`SSL_read`, which is a different tool. ([contact us](https://yeet.cx/?utm_source=github&utm_medium=readme&utm_campaign=httpinspect&utm_content=caveats-tls) for custom yeet scripts)
- Only the captured prefix (512 bytes) of each request is parsed — enough for the request line and `Host` header, which is all the table needs.
- **Latency is on-the-wire, not server-internal.** It's the time between the request and response segments as seen at this host's TC layer, so it includes network RTT for remote hosts. Responses are paired to requests FIFO per flow, which is correct for ordered HTTP/1.x but approximate under pipelining; unmatched requests are dropped after 10s.
- Loopback packets are seen twice (egress and ingress on `lo`); identical 4-tuple+seq sightings are de-duplicated so they're not double-counted.
- Under heavy load or a slow link, some segments may not be captured, so counts are a close lower bound rather than an exact tally.
- IPv6 packets carrying TCP behind extension-header chains (rare) are skipped.

## Community questions

**Does this need a proxy or a sidecar?**
No. `httpinspect` reads requests off the wire from inside the kernel's TC layer, so there's nothing to point traffic through and no app to reconfigure.

**Will it slow down or intercept my traffic?**
No. The programs observe and copy request segments; they don't hold, modify, or redirect packets.

**Why don't I see my HTTPS traffic?**
Because it's encrypted before it hits the wire. At the TC layer the payload is ciphertext, so there's no request line to parse. That's a fundamental limit of capturing here, not a bug.

**Why is a local service showing as `127.0.0.1:port`?**
That's the `Host:` header the client sent. Services addressed by name show their name; those addressed by IP show the IP.

**Can I get a quick check without the full TUI?**
Yes. `yeet run verify.js` attaches the probe, aggregates for ~4s, and prints the counts before exiting — a headless sanity check of the capture + parse pipeline.

## Building from source

```sh
make          # generates include/vmlinux.h, builds bin/httptop.bpf.o
make vmlinux  # force-refresh the kernel type header
make clean    # remove the build artifacts
```

Needs `clang` (BPF target) and `bpftool`, plus your distro's `libbpf` / `libbpf-dev` for headers. The generated `include/vmlinux.h` and `bin/` are build artifacts (gitignored).

## License

GPL-2.0. The BPF program declares `char LICENSE[] SEC("license") = "GPL"` in [`httptop.bpf.c`](httptop.bpf.c), required for the kernel helpers it uses.

---

Built with [yeet](https://yeet.cx/docs/?utm_source=github&utm_medium=readme&utm_campaign=httpinspect), a JS runtime for writing eBPF programs and live system dashboards on Linux. Join us on [discord](https://discord.gg/dYZu9PjKB?utm_source=github&utm_medium=readme&utm_campaign=httpinspect).
</content>
</invoke>
