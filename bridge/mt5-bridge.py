#!/usr/bin/env python3
"""
MT5 bridge — run this next to your MetaTrader 5 terminal, on Windows.

Why this exists: MetaTrader has NO public HTTP API. The only supported way to read bars from
an MT4/MT5 account is the Windows terminal itself, or the `MetaTrader5` Python package, which
ships as a `win_amd64` wheel only. There is no way to log in to a broker over HTTPS and ask
for candles — that is the honest answer to "can the app take my IC Markets login".

So the app talks to THIS process over localhost, and this process talks to the terminal.

What it does NOT do, by design:
  - never reads balance, equity, margin, open positions or order history
  - never places, modifies or closes an order
  - never writes the password to disk

The credential is used once, in memory, to attach the terminal to the account. After that the
terminal is already logged in and the password is not needed again.

Usage:
    pip install MetaTrader5
    python mt5-bridge.py --login 12345678 --password 'secret' --server ICMarkets-Demo

    # or, if the terminal is already logged in (recommended):
    python mt5-bridge.py

Then point the app at http://127.0.0.1:8765

Endpoints:
    GET  /health                       -> {ok, connected, symbols: n}
    GET  /symbols                      -> {symbols: [...]}
    GET  /candles?symbol=EURUSD&timeframe=M1&from=...&to=...  -> {candles: [...]}
    GET  /timeframes                   -> {timeframes: [...]}
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

try:
    import MetaTrader5 as mt5
except ImportError:
    print("ERROR: MetaTrader5 is not installed.", file=sys.stderr)
    print("  pip install MetaTrader5", file=sys.stderr)
    print("This package only ships for Windows (win_amd64). On Linux it cannot work.", file=sys.stderr)
    sys.exit(1)


# MetaTrader's timeframe constants, keyed by the app's own names. MT5 does not accept an
# arbitrary interval: asking for something absent here is a hard error, so this is a closed map.
TIMEFRAMES = {
    "M1": mt5.TIMEFRAME_M1,
    "M5": mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15,
    "M30": mt5.TIMEFRAME_M30,
    "H1": mt5.TIMEFRAME_H1,
    "H4": mt5.TIMEFRAME_H4,
    "D1": mt5.TIMEFRAME_D1,
}


def connect(login: int | None, password: str | None, server: str | None) -> tuple[bool, str]:
    """Attach to the terminal, logging in only if credentials were given."""
    if login and password and server:
        ok = mt5.initialize(login=login, password=password, server=server)
    else:
        # the terminal is already logged in, which is the better way to run this
        ok = mt5.initialize()

    if not ok:
        return False, f"initialize failed: {mt5.last_error()}"

    info = mt5.account_info()
    if info is None:
        return False, f"no account attached: {mt5.last_error()}"

    # Only these three fields are ever read, and only for the startup log. Balance, equity and
    # positions are deliberately not touched.
    return True, f"{info.server} #{info.login} ({'demo' if info.trade_mode == 0 else 'live'})"


def candles(symbol: str, timeframe: str, start: int, end: int) -> dict[str, Any]:
    """
    Bars for a range.

    `copy_rates_range` returns a numpy structured array. It is converted field by field rather
    than trusting the dtype order, because a mis-ordered array would produce a chart with the
    open and close swapped — which looks plausible and is completely wrong.
    """
    tf = TIMEFRAMES.get(timeframe.upper())
    if tf is None:
        return {"candles": [], "error": f"unknown timeframe {timeframe!r}; have {list(TIMEFRAMES)}"}

    # make the symbol visible in Market Watch, or copy_rates fails for a valid symbol
    if not mt5.symbol_select(symbol, True):
        return {"candles": [], "error": f"symbol {symbol!r} not available at this broker: {mt5.last_error()}"}

    from_dt = datetime.fromtimestamp(start, tz=timezone.utc)
    to_dt = datetime.fromtimestamp(end, tz=timezone.utc)
    rates = mt5.copy_rates_range(symbol, tf, from_dt, to_dt)

    if rates is None or len(rates) == 0:
        return {"candles": [], "error": f"no bars for {symbol} {timeframe} in that range: {mt5.last_error()}"}

    out = []
    for r in rates:
        out.append({
            "time": int(r["time"]),          # already epoch seconds, in the broker's server tz
            "open": float(r["open"]),
            "high": float(r["high"]),
            "low": float(r["low"]),
            "close": float(r["close"]),
            "volume": float(r["tick_volume"]),
        })
    return {"candles": out}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        # one line per request, so a slow symbol is visible
        sys.stderr.write("%s %s\n" % (self.command, self.path))

    def _send(self, code: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # the app runs on a different origin (file:// or app://), so CORS is required
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        u = urlparse(self.path)
        q = parse_qs(u.query)

        if u.path == "/health":
            info = mt5.account_info()
            self._send(200, {
                "ok": info is not None,
                "connected": info is not None,
                "symbols": len(mt5.symbols_get() or []),
            })
            return

        if u.path == "/timeframes":
            self._send(200, {"timeframes": list(TIMEFRAMES)})
            return

        if u.path == "/symbols":
            syms = mt5.symbols_get() or []
            self._send(200, {"symbols": [s.name for s in syms]})
            return

        if u.path == "/candles":
            symbol = (q.get("symbol") or [""])[0]
            tf = (q.get("timeframe") or ["M1"])[0]
            try:
                start = int((q.get("from") or ["0"])[0])
                end = int((q.get("to") or ["0"])[0])
            except ValueError:
                self._send(400, {"candles": [], "error": "from/to must be epoch seconds"})
                return
            if not symbol:
                self._send(400, {"candles": [], "error": "symbol is required"})
                return
            self._send(200, candles(symbol, tf, start, end))
            return

        self._send(404, {"error": "unknown endpoint"})

    def do_POST(self) -> None:  # noqa: N802
        # The app never posts credentials over this bridge on purpose: the terminal is logged in
        # before the bridge starts, so there is nothing to post.
        self._send(405, {"error": "the bridge is read-only; log in with the terminal or --login"})


def main() -> int:
    ap = argparse.ArgumentParser(description="Read-only MT4/MT5 candle bridge")
    ap.add_argument("--login", type=int, default=None, help="account number")
    ap.add_argument("--password", default=None, help="password (never written to disk)")
    ap.add_argument("--server", default=None, help="broker server, e.g. ICMarkets-Demo")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1", help="bind address; keep it on localhost")
    args = ap.parse_args()

    ok, msg = connect(args.login, args.password, args.server)
    if not ok:
        print(f"ERROR: {msg}", file=sys.stderr)
        return 1

    print(f"connected: {msg}")
    print(f"bridge listening on http://{args.host}:{args.port}")
    print("read-only: this bridge exposes candles and symbols, nothing else")

    try:
        ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
    finally:
        mt5.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
