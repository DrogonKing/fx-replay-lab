#!/usr/bin/env python3
"""
Fake MT5 bridge, for testing the app WITHOUT MetaTrader.

This is NOT a substitute for the real bridge — it stands in for it so the broker panel's
network path, error handling and symbol-suffix logic can be exercised on Linux. The real bridge
still has to be verified on Windows.

It deliberately mimics the real bridge's failure modes:
  - an unknown symbol gives a NAMED error, not an empty list
  - a broker suffix (EURUSD.m) is what it offers, so the panel's "use the broker's own names"
    path is exercised
  - /health reports connected: true only once

Usage: python scripts/fake-bridge.py [--port 18700]
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# a broker naming style that differs from the plain name, which is the realistic case
# Deliberately NO plain "EURUSD": that is the common real-world case, and it forces the panel to
# use the broker's own suffixed name instead of a hardcoded guess.
SYMBOLS = ["EURUSD.m", "GBPUSD.m", "USDJPY.m", "XAUUSD.m", "EURUSD.pro"]
PRICES = {"EURUSD.m": 1.10432, "EURUSD.pro": 1.10432, "GBPUSD.m": 1.27144,
          "USDJPY.m": 157.234, "XAUUSD.m": 2043.55}
BARS_PER_REQUEST = 500


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        sys.stderr.write("fake-bridge: %s %s\n" % (self.command, self.path))

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        u = urlparse(self.path)
        q = parse_qs(u.query)

        if u.path == "/health":
            self._send(200, {"ok": True, "connected": True, "symbols": len(SYMBOLS)})
            return

        if u.path == "/symbols":
            self._send(200, {"symbols": SYMBOLS})
            return

        if u.path == "/timeframes":
            self._send(200, {"timeframes": ["M1", "M5", "M15", "M30", "H1", "H4", "D1"]})
            return

        if u.path == "/candles":
            symbol = (q.get("symbol") or [""])[0]
            tf = (q.get("timeframe") or ["M1"])[0]
            if symbol not in PRICES:
                # the exact failure a user hits with a wrong suffix
                self._send(200, {
                    "candles": [],
                    "error": f"symbol {symbol!r} not available at this broker",
                })
                return
            if tf not in ("M1", "M5", "M15", "M30", "H1", "H4", "D1"):
                self._send(200, {
                    "candles": [],
                    "error": f"unknown timeframe {tf!r}; have ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1']",
                })
                return
            try:
                start = int((q.get("from") or ["0"])[0])
                end = int((q.get("to") or ["0"])[0])
            except ValueError:
                self._send(400, {"candles": [], "error": "from/to must be epoch seconds"})
                return

            base = PRICES[symbol]
            step = {"M1": 60, "M5": 300, "M15": 900, "M30": 1800,
                    "H1": 3600, "H4": 14400, "D1": 86400}[tf]
            out = []
            t = start
            i = 0
            while t <= end and i < BARS_PER_REQUEST:
                drift = base * (1 + 0.0001 * (i % 50) / 50)
                out.append({
                    "time": t,
                    "open": round(drift, 5),
                    "high": round(drift * 1.00002, 5),
                    "low": round(drift * 0.99998, 5),
                    "close": round(drift * 1.00001, 5),
                    "volume": float(10 + i % 7),
                })
                t += step
                i += 1
            self._send(200, {"candles": out})
            return

        self._send(404, {"error": "unknown endpoint"})

    def do_POST(self) -> None:  # noqa: N802
        u = urlparse(self.path)
        if u.path == "/login":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length).decode()) if length else {}
            except (ValueError, UnicodeDecodeError):
                self._send(400, {"error": "body must be JSON"})
                return
            login = str(body.get("login", ""))
            password = str(body.get("password", ""))
            server = str(body.get("server", ""))
            if not login or not password or not server:
                self._send(400, {"error": "login, password and server are all required"})
                return
            # a deliberately picky rule, so the panel's error path is exercised too
            if password == "wrong":
                self._send(200, {"ok": False, "error": "initialize failed: (-6, 'Authorization failed')"})
                return
            self._send(200, {
                "ok": True,
                "account": f"{server} #{login} (demo)",
                "symbols": len(SYMBOLS),
            })
            return
        self._send(405, {"error": "the bridge exposes candles, symbols and login; nothing else"})


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=18700)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()
    print(f"fake bridge on http://{a.host}:{a.port}", flush=True)
    print(f"symbols: {SYMBOLS}", flush=True)
    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
