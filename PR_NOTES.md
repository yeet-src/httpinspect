# PR notes: Go port

## Summary

- Ported the userspace HTTP endpoint dashboard from Yeet/JS to a native Go binary.
- Preserved the visible behavior: interface selection, query collapsing, endpoint ranking, detail view, status tallying, latency pairing, loopback de-dupe, and headless verification.
- Small usage change: run `httpinspect` directly; use `httpinspect --verify` instead of `yeet run verify.js`.
- Message from shreyam1008: love the yeet.cx collection

## Benchmark plan

Use `scripts/bench.sh` on a Linux host with the needed privileges:

```sh
# From the pre-port checkout with yeet + clang available:
./scripts/bench.sh yeet

# From this Go checkout:
./scripts/bench.sh go
```

The script reports max RSS, elapsed time, captured endpoint counts, and binary/object size. In this workspace the successful benchmark was run inside a privileged Docker container so packet capture did not require host sudo.

## Local results

Environment: Ubuntu 24.04 container, host kernel `6.8.0-49-generic`, privileged Docker, generated loopback traffic against `python3 -m http.server`.

| version | command | result |
| --- | --- | --- |
| Go port | `SKIP_BUILD=1 DURATION=6 ./scripts/bench.sh go` | `binary_bytes=2130185`, `rss_kb=6272`, `elapsed_s=6.02`, captured `685` requests, paired `685` responses, `p50=0.03ms`, `p95=10ms` |
| Original Yeet verify | `DURATION=6 ./scripts/bench.sh yeet` | `yeet_binary_bytes=52470528`, `bpf_object_bytes=31864`, exited after attach without aggregate output under Yeet `0.19.2` |
| Original Yeet TUI | `TARGET=tui DURATION=6 ./scripts/bench.sh yeet` | BPF object built, but load failed: kernel verifier rejected the original program with `R4 invalid zero-sized read` |

Checks run here: `make build`, `go test ./...` (request/status parser coverage), containerized `--verify` capture benchmark.

Notes:

- Host user has no root/`CAP_NET_RAW` and no passwordless `sudo`; Docker was used for privileged runtime checks.
- `yeet` and `clang` were not installed on the host; they were installed only inside the original-version benchmark container.
- The required Yeet raw guide at `https://kmux.xyz/docs/raw/index.md` returned HTTP 530 here, so the local source was used as the behavior contract.
