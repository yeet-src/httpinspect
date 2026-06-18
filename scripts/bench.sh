#!/usr/bin/env bash
set -euo pipefail

MODE=${1:-go}              # go | yeet
DURATION=${DURATION:-6}    # seconds
PORT=${PORT:-18080}
IFACE=${IFACE:-lo}
SUDO=${SUDO:-}
TARGET=${TARGET:-verify}   # verify | tui

if [ "$(id -u)" -ne 0 ] && [ -z "$SUDO" ] && command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  SUDO=sudo
fi

tmp=$(mktemp -d)
cleanup() {
  jobs -p | xargs -r kill 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT

python3 -m http.server "$PORT" --bind 127.0.0.1 >"$tmp/server.log" 2>&1 &
server=$!
sleep 0.4

(
  end=$((SECONDS + DURATION))
  i=0
  while [ "$SECONDS" -lt "$end" ]; do
    curl -fsS "http://127.0.0.1:$PORT/bench?i=$i" >/dev/null 2>&1 || true
    i=$((i + 1))
  done
) &
traffic=$!

case "$MODE" in
  go)
    if [ "${SKIP_BUILD:-0}" != "1" ]; then
      make build >/dev/null
    fi
    size=$(wc -c < bin/httpinspect)
    set +e
    if [ "$TARGET" = "tui" ]; then
      /usr/bin/time -f 'rss_kb=%M elapsed_s=%e' -o "$tmp/time" \
        timeout "${DURATION}s" script -q -e -c "$SUDO ./bin/httpinspect --iface $IFACE" /dev/null >"$tmp/out" 2>"$tmp/err"
    else
      /usr/bin/time -f 'rss_kb=%M elapsed_s=%e' -o "$tmp/time" \
        $SUDO ./bin/httpinspect --verify --duration "${DURATION}s" --iface "$IFACE" >"$tmp/out" 2>"$tmp/err"
    fi
    status=$?
    if [ "$TARGET" = "tui" ] && [ "$status" -eq 124 ]; then status=0; fi
    set -e
    echo "mode=go target=$TARGET binary_bytes=$size"
    ;;
  yeet)
    make >/dev/null
    yeet_bin=$(command -v yeet)
    yeet_size=$(wc -c < "$yeet_bin")
    bpf_size=$(wc -c < bin/httptop.bpf.o)
    set +e
    if [ "$TARGET" = "tui" ]; then
      /usr/bin/time -f 'rss_kb=%M elapsed_s=%e' -o "$tmp/time" \
        timeout "${DURATION}s" script -q -e -c "yeet run . --iface $IFACE" /dev/null >"$tmp/out" 2>"$tmp/err"
    else
      timeout "$((DURATION + 3))s" /usr/bin/time -f 'rss_kb=%M elapsed_s=%e' -o "$tmp/time" \
        yeet run verify.js >"$tmp/out" 2>"$tmp/err"
    fi
    status=$?
    if [ "$TARGET" = "tui" ] && [ "$status" -eq 124 ]; then status=0; fi
    set -e
    echo "mode=yeet target=$TARGET yeet_binary_bytes=$yeet_size bpf_object_bytes=$bpf_size"
    ;;
  *)
    echo "usage: $0 [go|yeet]" >&2
    exit 2
    ;;
esac

wait "$traffic" 2>/dev/null || true
kill "$server" 2>/dev/null || true

cat "$tmp/time"
cat "$tmp/out"
if [ -s "$tmp/err" ]; then
  echo "stderr:" >&2
  cat "$tmp/err" >&2
fi
exit "${status:-0}"
