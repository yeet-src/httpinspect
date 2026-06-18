# `httpinspect`

> **`top` for the HTTP endpoints on your host.** Every plaintext HTTP request crossing the box, decoded off the wire and ranked live in your terminal by traffic, rate, and latency. No proxy, no sidecar, no app changes.

<p align="center">
  <img src="https://img.shields.io/badge/platform-Linux-1793D1" alt="Linux">
  <img src="https://img.shields.io/badge/built%20with-Go-00ADD8" alt="Go">
  <img src="https://img.shields.io/badge/license-GPL--2.0-3DA639" alt="GPL-2.0">
  <a href="https://discord.gg/dYZu9PjKB"><img src="https://img.shields.io/badge/chat-Discord-5865F2" alt="Discord"></a>
</p>

<p align="center">
  <img src="assets/http-endpoint.gif" alt="httpinspect - a live HTTP endpoint dashboard in the terminal" width="820">
</p>

`httpinspect` turns plaintext HTTP crossing your Linux host into a live `top`-style table. It opens raw packet sockets on the selected interfaces, parses HTTP/1.x request and response prefixes, aggregates by `METHOD host path`, and pairs responses with requests to estimate on-the-wire latency.

## Quick start

```sh
go build -o bin/httpinspect .
sudo ./bin/httpinspect
```

Flags:

| flag             | default       | meaning                                                          |
| ---------------- | ------------- | ---------------------------------------------------------------- |
| `--iface=<list>` | all up ifaces | comma-separated interface names, e.g. `--iface=lo,eth0`          |
| `--keep-query`   | off           | keep query strings distinct instead of collapsing them by path   |
| `--verify`       | off           | headless capture sanity check                                    |
| `--duration`     | `4.5s`        | duration for `--verify`                                          |

```sh
sudo ./bin/httpinspect --iface lo,eth0
sudo ./bin/httpinspect --keep-query
sudo ./bin/httpinspect --verify --iface lo
```

## What you're looking at

```text
httpinspect · iface: all (3) · plaintext HTTP only
 #  METHOD  HOST            PATH              COUNT   REQ/S   LAST
 1  GET     shop.internal   /api/products      1843    27     0s
 2  POST    auth.internal   /login              512     4      1s
 3  GET     shop.internal   /health             318     ·      3s
```

The list is one row per endpoint, sorted by total count. `Enter` opens the detail screen for the selected endpoint with request share, current and peak req/s, latency p50/p95/max, status-code mix, byte totals, and recent sparklines.

## Navigation

| key                      | action                                            |
| ------------------------ | ------------------------------------------------- |
| `↑` / `↓` or `k` / `j`   | move selection                                    |
| `PgUp` / `PgDn`          | jump ten rows                                     |
| `Enter`                  | open endpoint detail                              |
| `Esc` / `←`              | return to list                                    |
| `q`                      | back to list in detail, quit from list            |
| `Ctrl-C`                 | quit                                              |

## How it works

The Go binary enumerates up interfaces, opens one `AF_PACKET` raw socket per interface, and parses TCP payloads that start with an HTTP method token or `HTTP/`. Requests carry the request line and `Host` header; responses carry the status line. Non-HTTP packets are ignored in userspace.

Responses are paired with the oldest unmatched request on the same unordered port pair, matching the original HTTP/1.x FIFO assumption. Loopback double sightings are de-duplicated by family, port pair direction, and TCP sequence number.

## Requirements

- Linux.
- Root or `CAP_NET_RAW` to open packet sockets.
- Plaintext HTTP. TLS payloads are encrypted at this layer and are not visible.
- A real terminal for the TUI. Use `--verify` for scripts, CI, or benchmark runs.

## Caveats

- Counts are a close lower bound under heavy load; packet capture can drop if userspace cannot keep up.
- IPv6 packets with extension-header chains are skipped, matching the original behavior.
- Latency is on-the-wire latency as observed at this host, not server-internal time.
- HTTP/1.x pipelining is approximate because responses are paired FIFO per port pair.

## Building from source

```sh
make          # builds bin/httpinspect
make verify   # runs a headless capture check on lo
make clean
```

## Benchmarking

```sh
./scripts/bench.sh go
```

For a before/after PR table, run `scripts/bench.sh yeet` from a pre-port checkout with Yeet and clang available, then run `scripts/bench.sh go` from this checkout.

## License

GPL-2.0.
