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

# Imported without exiting on failure, so --selftest can REPORT the problem instead of dying
# on it. A diagnostic that cannot run without the thing it diagnoses is useless.
try:
    import MetaTrader5 as mt5
    MT5_IMPORT_ERROR: str | None = None
except ImportError as exc:
    mt5 = None  # type: ignore[assignment]
    MT5_IMPORT_ERROR = str(exc)


# MetaTrader's timeframe constants, keyed by the app's own names. MT5 does not accept an
# arbitrary interval: asking for something absent here is a hard error, so this is a closed map.
#
# Built LAZILY, because the module must import on a machine without MetaTrader5 — that is the
# machine --selftest is for. A module-level dict dereferencing mt5 crashed the whole file.
_TIMEFRAME_NAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"]
_tf_cache: dict[str, int] = {}


def timeframes() -> dict[str, int]:
    """The timeframe map, built once the package is known to exist."""
    if not _tf_cache and mt5 is not None:
        for name in _TIMEFRAME_NAMES:
            _tf_cache[name] = getattr(mt5, f"TIMEFRAME_{name}")
    return _tf_cache


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
    tf = timeframes().get(timeframe.upper())
    if tf is None:
        return {"candles": [], "error": f"unknown timeframe {timeframe!r}; have {list(timeframes())}"}

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
            self._send(200, {"timeframes": list(timeframes())})
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


def selftest() -> int:
    """
    Check everything, in order, and report. Never raises.

    Order matters: each step depends on the previous one, so the first failure is the real
    problem and everything after it is a consequence. Saying "no bars" when the actual problem
    is a missing package would send the user looking in the wrong place.
    """
    print("=" * 62)
    print("MT5 BRIDGE SELF-TEST")
    print("=" * 62)

    checks: list[tuple[str, bool, str]] = []

    # 1. platform
    is_windows = sys.platform.startswith("win")
    checks.append((
        "Windows",
        is_windows,
        "yes" if is_windows else f"no ({sys.platform}) — MetaTrader5 is a Windows-only build",
    ))

    # 2. python version, since the wheel is per-version
    v = f"{sys.version_info.major}.{sys.version_info.minor}"
    checks.append(("Python " + v, True, "cp" + v.replace(".", "")))

    # 3. the package
    checks.append((
        "MetaTrader5 package",
        mt5 is not None,
        "imported" if mt5 is not None else f"missing: {MT5_IMPORT_ERROR}",
    ))
    if mt5 is None:
        _report(checks)
        print()
        print("STOP HERE: without the package nothing else can be tested.")
        print("  On Windows:  pip install MetaTrader5")
        print("  On Linux:    not possible — this needs a Windows machine or VM.")
        return 1

    # 4. is a terminal running and logged in?
    #    initialize() with no arguments attaches to whatever the terminal is doing, which is
    #    why it is tried FIRST: if this works, no credentials are needed at all.
    attached = mt5.initialize()
    info = mt5.account_info() if attached else None
    checks.append((
        "terminal already running and logged in",
        attached and info is not None,
        (f"{info.server} #{info.login}" if info is not None
         else f"no ({mt5.last_error()}) — start MetaTrader and log in, then retry"),
    ))

    if info is None:
        _report(checks)
        print()
        print("The cleanest fix: open MetaTrader, log in to the demo account by hand,")
        print("then run this script with no arguments. Credentials are then not needed.")
        print("Or pass --login --password --server to let the script log in.")
        return 1

    # 5. can it see symbols at all?
    syms = mt5.symbols_get() or []
    checks.append(("symbols visible", len(syms) > 0, f"{len(syms)} symbols"))

    # 6. the real test: can it read EURUSD M1 bars?
    if syms:
        mt5.symbol_select("EURUSD", True)
        from_dt = datetime(2024, 1, 2, tzinfo=timezone.utc)
        to_dt = datetime(2024, 1, 3, tzinfo=timezone.utc)
        rates = mt5.copy_rates_range("EURUSD", mt5.TIMEFRAME_M1, from_dt, to_dt)
        n = 0 if rates is None else len(rates)
        checks.append((
            "EURUSD M1 bars (2024-01-02)",
            n > 0,
            f"{n} bars" + ("" if n else f" — {mt5.last_error()}"),
        ))
        if n > 0:
            r = rates[0]
            checks.append((
                "bar prices plausible",
                # a wrong symbol or a broken broker feed gives 0 or a giant number
                0.5 < float(r["open"]) < 2.0,
                f"first open {float(r['open']):.5f}",
            ))

    _report(checks)
    mt5.shutdown()

    failed = [c for c in checks if not c[1]]
    if failed:
        print()
        print(f"{len(failed)} check(s) failed — see above.")
        return 1
    print()
    print("ALL CHECKS PASSED. Start the bridge:")
    print("  python mt5-bridge.py")
    return 0


def _report(checks: list[tuple[str, bool, str]]) -> None:
    for name, ok, detail in checks:
        mark = "PASS" if ok else "FAIL"
        print(f"  [{mark}] {name:42} {detail}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Read-only MT4/MT5 candle bridge")
    ap.add_argument("--login", type=int, default=None, help="account number")
    ap.add_argument("--password", default=None, help="password (never written to disk)")
    ap.add_argument("--server", default=None, help="broker server, e.g. ICMarkets-Demo")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1", help="bind address; keep it on localhost")
    ap.add_argument("--selftest", action="store_true",
                    help="check every dependency and report, without starting the server")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    if mt5 is None:
        print(f"ERROR: MetaTrader5 is not available: {MT5_IMPORT_ERROR}", file=sys.stderr)
        print("  On Windows: pip install MetaTrader5", file=sys.stderr)
        print("  On Linux: this package ships win_amd64 wheels only.", file=sys.stderr)
        print("  Run with --selftest to see the full diagnosis.", file=sys.stderr)
        return 1

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
