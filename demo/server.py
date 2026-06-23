#!/usr/bin/env python3
"""Tiny plaintext-HTTP server for the httptop demo recording.

Routes return canned JSON with a route-specific, jittered latency and a mix of
status codes, so the dashboard fills with realistic endpoints, methods, 2xx/
4xx/5xx codes, and a spread of p50/p95 latencies. Binds loopback only.

    python3 server.py [port]      # default 8731
"""
import random
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# (method, path regex) -> (status, base_ms, jitter_ms)
ROUTES = [
    ("GET",    r"/healthz$",            200, 2,   3),
    ("GET",    r"/api/products$",       200, 15,  12),
    ("GET",    r"/api/products/\d+$",   200, 22,  18),
    ("POST",   r"/api/cart$",           201, 40,  30),
    ("DELETE", r"/api/cart/\d+$",       204, 28,  15),
    ("POST",   r"/auth/login$",         200, 65,  45),
    ("GET",    r"/api/orders$",         200, 80,  60),   # occasionally 500 (below)
    ("GET",    r"/api/recommendations$", 200, 130, 90),  # the slow path
]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _route(self):
        path = self.path.split("?", 1)[0]
        status, base, jit = 404, 4, 4  # default: not found
        for method, rx, st, b, j in ROUTES:
            if self.command == method and re.search(rx, path):
                status, base, jit = st, b, j
                break
        if path == "/api/orders" and random.random() < 0.08:
            status = 500  # flaky endpoint, for a splash of red
        return status, base, jit

    def _handle(self):
        status, base, jit = self._route()
        time.sleep((base + random.random() * jit) / 1000.0)  # simulate work
        body = b"" if status in (204, 304) else (
            b'{"ok":true}\n' if status < 400 else b'{"error":true}\n')
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD" and body:
            try:
                self.wfile.write(body)
            except BrokenPipeError:
                pass

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = _handle

    def log_message(self, *args):
        pass  # stay quiet; the dashboard is the output


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8731
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
