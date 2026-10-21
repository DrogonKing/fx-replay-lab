#!/usr/bin/env python3
"""
Test the bridge's HTTP layer WITHOUT MetaTrader.

The point is narrow and worth being explicit about: this does NOT test the bridge against a
broker. It tests the HTTP shell — routes, JSON shape, error messages, CORS, the read-only 405 —
using a stub that imitates MetaTrader5's API. The broker data path stays unverified until this
runs on a real terminal, and calling this test "the bridge works" would be a lie.

What it does prove is that when the user runs it on Windows, the failures they hit will be
broker failures, not code failures.
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

STUB = '''
"""Stands in for MetaTrader5: same function names, same return shapes."""

import datetime

TIMEFRAME_M1 = 1
TIMEFRAME_M5 = 5
TIMEFRAME_M15 = 15
TIMEFRAME_M30 = 30
TIMEFRAME_H1 = 60
TIMEFRAME_H4 = 240
TIMEFRAME_D1 = 1440

_connected = False


class _Info:
    login = 12345678
    server = "StubBroker-Demo"
    trade_mode = 0


class _Symbol:
    def __init__(self, name):
        self.name = name


class _Row(dict):
    """copy_rates_range returns a structured array; dict with key access is close enough."""


def initialize(**kwargs):
    global _connected
    _connected = True
    return True


def shutdown():
    global _connected
    _connected = False


def last_error():
    return (0, "no error")


def account_info():
    return _Info() if _connected else None


def symbols_get():
    if not _connected:
        return None
    return [_Symbol(n) for n in ("EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "EURUSD.m")]


def symbol_select(name, enable=True):
    # a broker suffix that does not exist must be rejected, like the real API
    return name in ("EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "EURUSD.m")


def copy_rates_range(symbol, timeframe, start, end):
    if not _connected or symbol not in ("EURUSD", "GBPUSD", "USDJPY", "XAUUSD"):
        return None
    if symbol == "USDJPY":
        base = 157.234
    elif symbol == "XAUUSD":
        base = 2043.55
    else:
        base = 1.10432
    out = []
    t = int(start.replace(tzinfo=datetime.timezone.utc).timestamp())
    for i in range(1440):
        out.append(_Row(
            time=t + i * 60,
            open=base + i * 0.00001,
            high=base + i * 0.00002,
            low=base - i * 0.00001,
            close=base + i * 0.000015,
            tick_volume=10 + i % 7,
        ))
    return out
'''


def get(url: str, timeout: float = 10.0) -> tuple[int, str]:
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def post(url: str, timeout: float = 10.0) -> tuple[int, str]:
    req = urllib.request.Request(url, data=b"{}", method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def main() -> int:
    work = Path(tempfile.mkdtemp(prefix="mt5stub-"))
    (work / "MetaTrader5.py").write_text(STUB)

    port = 18765
    env = dict(os.environ)
    env["PYTHONPATH"] = str(work)
    # unbuffered, so the startup lines appear immediately
    env["PYTHONUNBUFFERED"] = "1"

    bridge = Path(__file__).resolve().parent / "mt5-bridge.py"
    proc = subprocess.Popen(
        [sys.executable, "-u", str(bridge), "--port", str(port)],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )

    base = f"http://127.0.0.1:{port}"
    ready = False
    for _ in range(40):
        time.sleep(0.25)
        try:
            code, _ = get(base + "/health", timeout=1)
            if code == 200:
                ready = True
                break
        except Exception:
            pass

    if not ready:
        out = proc.stdout.read() if proc.stdout else ""
        print("bridge did not start. output:")
        print(out[:1200])
        proc.kill()
        return 1

    results: list[tuple[str, bool, str]] = []
    try:
        print("=" * 70)
        print("BRIDGE HTTP LAYER — via a stub MetaTrader5, NOT a real broker")
        print("=" * 70)

        # 1. health
        code, body = get(base + "/health")
        d = json.loads(body)
        results.append(("health 200 + connected", code == 200 and d.get("connected") is True, body[:90]))

        # 2. symbols
        code, body = get(base + "/symbols")
        d = json.loads(body)
        has_suffix_symbol = "EURUSD.m" in d.get("symbols", [])
        results.append((
            "symbols lists the broker's own names",
            code == 200 and len(d.get("symbols", [])) == 5 and has_suffix_symbol,
            f"{len(d.get('symbols', []))} symbols incl. EURUSD.m",
        ))

        # 3. timeframes
        code, body = get(base + "/timeframes")
        d = json.loads(body)
        results.append((
            "timeframes are MT5's closed set",
            code == 200 and d.get("timeframes") == ["M1", "M5", "M15", "M30", "H1", "H4", "D1"],
            str(d.get("timeframes")),
        ))

        # 4. real candle request
        code, body = get(base + "/candles?symbol=EURUSD&timeframe=M1&from=1704153600&to=1704239999")
        d = json.loads(body)
        cs = d.get("candles", [])
        ok = code == 200 and len(cs) == 1440
        shape_ok = ok and all(k in cs[0] for k in ("time", "open", "high", "low", "close", "volume"))
        results.append((
            "candles: 1440 bars with OHLCV",
            bool(shape_ok),
            f"{len(cs)} bars, first={cs[0] if cs else None}",
        ))

        # 5. the suffix case a real user WILL hit
        code, body = get(base + "/candles?symbol=NOPEUSD&timeframe=M1&from=1704153600&to=1704239999")
        d = json.loads(body)
        results.append((
            "unknown symbol gives a NAMED error, not an empty list",
            "not available at this broker" in (d.get("error") or ""),
            (d.get("error") or "")[:80],
        ))

        # 6. unknown timeframe
        code, body = get(base + "/candles?symbol=EURUSD&timeframe=M7&from=1&to=2")
        d = json.loads(body)
        results.append((
            "unknown timeframe names the valid ones",
            "unknown timeframe" in (d.get("error") or "") and "M1" in (d.get("error") or ""),
            (d.get("error") or "")[:80],
        ))

        # 7. missing symbol
        code, body = get(base + "/candles?timeframe=M1&from=1&to=2")
        d = json.loads(body)
        results.append(("missing symbol is a 400", code == 400, (d.get("error") or "")[:60]))

        # 8. bad from/to
        code, body = get(base + "/candles?symbol=EURUSD&timeframe=M1&from=abc&to=2")
        d = json.loads(body)
        results.append(("non-numeric from/to is a 400", code == 400, (d.get("error") or "")[:60]))

        # 9. READ-ONLY: no way to touch the account
        code, body = post(base + "/orders")
        d = json.loads(body)
        results.append((
            "POST is refused (405) — no account access",
            code == 405 and "read-only" in (d.get("error") or ""),
            f"{code} {d.get('error','')[:40]}",
        ))

        # 10. CORS, because the app runs on a different origin
        req = urllib.request.Request(base + "/health")
        with urllib.request.urlopen(req, timeout=5) as r:
            cors = r.headers.get("Access-Control-Allow-Origin")
        results.append(("CORS header present", cors == "*", str(cors)))

        # 11. unknown route
        code, body = get(base + "/nope")
        results.append(("unknown route is a 404", code == 404, str(code)))

    finally:
        proc.kill()
        try:
            proc.wait(timeout=5)
        except Exception:
            pass

    print()
    passed = 0
    for name, ok, detail in results:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name:52} {detail}")
        if ok:
            passed += 1
    print()
    print(f"{passed}/{len(results)} passed")
    print()
    print("REMINDER: this proves the HTTP shell, not the broker link. The MetaTrader5 call path")
    print("is still unverified until --selftest passes on your Windows machine.")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
