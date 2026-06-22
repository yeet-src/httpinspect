#!/usr/bin/env bash
# Record the httptop demo gif with real traffic flowing.
#
# Spins up a fake HTTP server + load generator (demo/traffic.sh) as background
# traffic via `termgif --bg`, so the dashboard fills with live endpoints, status
# codes, and latency — then captures `yeet run .`.
#
#   demo/record.sh                       # -> assets/http-endpoint.gif
#   demo/record.sh path/to/out.gif       # custom output
#   PORT=9001 demo/record.sh             # use a different server port
#
# Needs: termgif on PATH (~/src/bin), the yeet daemon, clang + bpftool (for make),
# python3 + curl. Run from anywhere — paths resolve relative to this script.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PORT="${PORT:-8731}"
OUT="${1:-$ROOT/assets/http-endpoint.gif}"

command -v termgif >/dev/null 2>&1 || { echo "record: termgif not on PATH (try: export PATH=\"\$HOME/src/bin:\$PATH\")" >&2; exit 1; }

# Make sure the probe is built before we record.
make -C "$ROOT"

# Once the recording is visible, walk down the list and open an endpoint's
# detail screen, then step back out — so the gif shows the dashboard being
# driven, not just sitting there. termgif injects these into the tape after the
# table is on screen; the Sleeps here set the gif's pacing and total length.
KEYS='Sleep 2500ms
Down
Sleep 700ms
Down
Sleep 700ms
Down
Sleep 1200ms
Enter
Sleep 4500ms
Escape
Sleep 2000ms'

# termgif starts --bg before the recorded command and kills its process group
# when done. We give a long warmup so the server is up and the table + req/s
# rates have settled before the recording becomes visible.
cd "$ROOT"
PORT="$PORT" termgif \
  -o "$OUT" \
  -c 92 -r 28 -f 16 \
  --warmup 5000 \
  --keys "$KEYS" \
  --bg "PORT=$PORT bash '$HERE/traffic.sh'" \
  -- yeet run .

echo "record: wrote $OUT" >&2
