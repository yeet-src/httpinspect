#!/usr/bin/env bash
# Background load for the httptop demo (the `termgif --bg` payload).
#
# Starts the fake server, waits for it to accept connections, then sends a
# steady, weighted mix of plaintext HTTP requests over loopback until killed.
# `--bg` runs this in its own session and SIGTERMs the group when the recording
# ends; the trap below tears the server down with it.
#
# The requests go to 127.0.0.1 (so httptop captures them on `lo`), but each
# carries a `Host:` header — httptop keys on that, so the dashboard shows
# realistic hostnames (shop.internal, auth.internal, …) instead of the loopback
# address.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8731}"
BASE="http://127.0.0.1:${PORT}"

python3 "$HERE/server.py" "$PORT" &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null || true' EXIT INT TERM

# Wait (up to ~5s) for the server to come up.
for _ in $(seq 1 50); do
  curl -s -o /dev/null "$BASE/healthz" && break || sleep 0.1
done

# method path host  — one request over a fresh connection.
req() { curl -s -o /dev/null -X "$1" -H "Host: $3" "$BASE$2"; }

# Weighted mix: healthz is chatty, recommendations is rare and slow. Methods
# and hosts vary so every dashboard column has something to show.
while true; do
  req GET    /healthz                            shop.internal
  req GET    /api/products                       shop.internal
  req GET    "/api/products/$((RANDOM % 900 + 100))" shop.internal
  req GET    /healthz                            shop.internal
  req POST   /api/cart                           shop.internal
  req GET    /api/orders                         shop.internal
  req GET    /healthz                            shop.internal
  req POST   /auth/login                         auth.internal
  req DELETE "/api/cart/$((RANDOM % 900 + 100))" shop.internal
  req GET    /static/app.js                      cdn.internal
  req GET    /api/recommendations                reco.internal
  sleep 0.15
done
