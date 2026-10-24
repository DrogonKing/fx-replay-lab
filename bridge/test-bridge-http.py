#!/usr/bin/env python3
"""
Test the bridge's HTTP layer WITHOUT MetaTrader.

The point is narrow and worth being explicit about: this does NOT test the bridge against a
broker. It tests the HTTP shell — routes, JSON shape, error messages, CORS, the real
credential login, the UTC shift, the read-only 405 — using a stub that imitates
MetaTrader5's API. The broker data path stays unverified until --selftest runs on a real
logged-in terminal, and calling this test "the bridge works" would be a lie.

What it does prove is that when the user runs it on Windows, the failures they hit will be
broker failures, not code failures.

How the stub gets injected: the suite writes a stub MetaTrader5.py into a temp dir and
launches the bridge with a `python -c` shim that sys.path.inserts that dir. PYTHONPATH alone
is NOT enough for the vendored runtime (bridge/python) — it is an embeddable build whose
python311._pth implies isolated mode and IGNORES PYTHONPATH. PYTHONPATH is still set for the
case of running this suite with a normal PATH python. The stub therefore shadows the REAL
vendored package only for the few seconds this suite runs, never in production.

The stub records every initialize() call (its kwargs) to a JSON file, which is how the suite
proves the bridge actually forwards login/password/server to mt5.initialize — the v1 bug was
accepting credentials and silently dropping them.

One caveat worth a warning: on a machine that has a REAL MetaTrader window open while this
suite runs, the bridge's window-hider will hide it (that is its contract). Restart the
terminal afterwards if that happens; this suite is normally run on boxes without one.
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
"""Stands in for MetaTrader5: same function names, same return shapes.

Deliberately contrived where the v2 contract needs determinism:
  - initialize() RECORDS its kwargs, so the suite can prove the bridge passed the
    credentials through (the v1 bug dropped them);
  - when asked to fail with password "leak-me", last_error() echoes the password back, so
    the suite can prove the bridge scrubs it before replying;
  - bars carry a FAKE +7200 s server timezone, with the newest M1 bar opened 45 s ago —
    45 (not 30) keeps the bridge's round()-to-minute offset detection off the .5 rounding
    boundary, so the detected offset is exactly 7200 on every run.
"""
import datetime
import json
import time

RECORD_PATH = __RECORD__
FAKE_SERVER_OFFSET = 7200

TIMEFRAME_M1 = 1
TIMEFRAME_M5 = 5
TIMEFRAME_M15 = 15
TIMEFRAME_M30 = 30
TIMEFRAME_H1 = 60
TIMEFRAME_H4 = 240
TIMEFRAME_D1 = 1440

_events = []
_connected = False
_grant_bare_attach = False
_last_error = (0, "no error")


def _record(event):
    _events.append(event)
    # rewritten whole on every call: the suite reads it only after the bridge exits, so a
    # torn file is impossible from its point of view
    with open(RECORD_PATH, "w") as f:
        json.dump(_events, f)


class _Info:
    login = 424242
    server = "StubServer"
    company = "Stub Capital Ltd"
    trade_mode = 0


class _Symbol:
    def __init__(self, name):
        self.name = name


class _Row(dict):
    """copy_rates_* return a structured array; dict with key access is close enough."""


def _base_price(symbol):
    if symbol == "USDJPY":
        return 157.234
    if symbol == "XAUUSD":
        return 2043.55
    return 1.10432


def initialize(**kwargs):
    global _connected, _grant_bare_attach, _last_error
    _record({"call": "initialize", "kwargs": kwargs})
    _last_error = (0, "no error")
    password = kwargs.get("password")
    if password == "leak-me":
        # fail AND put the password in last_error: proves the bridge scrubs outgoing errors
        _last_error = (-6, "Authorization failed for password=leak-me on StubServer")
        _grant_bare_attach = False
        return False
    if password == "attach-only":
        # credential login fails, but a bare attach is allowed (terminal already on the
        # account) — exercises the bridge's documented fallback path
        _grant_bare_attach = True
        return False
    if not kwargs:
        if _grant_bare_attach:
            _connected = True
            return True
        return _connected
    _grant_bare_attach = False
    _connected = True
    return True


def shutdown():
    global _connected, _grant_bare_attach
    _record({"call": "shutdown"})
    _connected = False
    _grant_bare_attach = False


def last_error():
    return _last_error


def account_info():
    return _Info() if _connected else None


def symbols_get():
    if not _connected:
        return None
    return [_Symbol(n) for n in ("EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "EURUSD.m")]


def symbol_select(name, enable=True):
    # a broker suffix that does not exist must be rejected, like the real API
    return name in ("EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "EURUSD.m")


class _Tick:
    """A fresh tick on the FAKE server clock: offset detection reads ticks, not bars."""

    def __init__(self):
        self.time = int(time.time()) + FAKE_SERVER_OFFSET - 45
        self.time_msc = self.time * 1000
        self.bid = 1.10432
        self.ask = 1.10442


def symbol_info_tick(symbol):
    # BTCUSD deliberately NOT tickable in the stub, so the detector exercises its
    # fall-through to the next symbol instead of always hitting the first candidate
    if _connected and symbol in ("EURUSD", "GBPUSD", "USDJPY", "XAUUSD"):
        return _Tick()
    return None


def copy_rates_from_pos(symbol, timeframe, start_pos=0, count=3):
    if not _connected or symbol not in ("EURUSD", "GBPUSD", "USDJPY", "XAUUSD"):
        return None
    base = _base_price(symbol)
    newest = int(time.time()) + FAKE_SERVER_OFFSET - 45
    return [
        _Row(time=newest - i * 60,
             open=base + i * 0.00001,
             high=base + i * 0.00002,
             low=base - i * 0.00001,
             close=base + i * 0.000015,
             tick_volume=10 + i % 7)
        for i in range(count - 1, -1, -1)
    ]


def copy_rates_range(symbol, timeframe, start, end):
    if not _connected or symbol not in ("EURUSD", "GBPUSD", "USDJPY", "XAUUSD"):
        return None
    base = _base_price(symbol)
    t = int(start.replace(tzinfo=datetime.timezone.utc).timestamp())
    return [
        _Row(time=t + i * 60,
             open=base + i * 0.00001,
             high=base + i * 0.00002,
             low=base - i * 0.00001,
             close=base + i * 0.000015,
             tick_volume=10 + i % 7)
        for i in range(1440)
    ]
'''


def get(url: str, timeout: float = 10.0) -> tuple[int, str]:
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def post(url: str, body: bytes = b"{}", timeout: float = 10.0) -> tuple[int, str]:
    req = urllib.request.Request(url, data=body, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def main() -> int:
    work = Path(tempfile.mkdtemp(prefix="mt5stub-"))
    record = work / "record.json"
    (work / "MetaTrader5.py").write_text(STUB.replace("__RECORD__", repr(str(record))))
    # A stand-in executable so _find_terminal() finds "a terminal" even on a machine with no
    # MetaTrader installed at all — the bridge honors MT5_BRIDGE_TERMINAL exactly so this
    # suite stays hermetic. mt5.initialize is stubbed, so the file is never executed.
    (work / "terminal64.exe").write_bytes(b"")

    port = 18765
    env = dict(os.environ)
    env["PYTHONPATH"] = str(work)  # kept for a normal PATH python; the vendored one needs the shim below
    env["PYTHONUNBUFFERED"] = "1"
    env["MT5_BRIDGE_TERMINAL"] = str(work / "terminal64.exe")
    # the bridge's cold-start path Popen()s a real terminal when none is running; the
    # stand-in file is not executable, and a unit test must not launch GUI apps anyway
    env["MT5_BRIDGE_NO_LAUNCH"] = "1"

    bridge = Path(__file__).resolve().parent / "mt5-bridge.py"
    shim = (
        "import sys, runpy; "
        "sys.path.insert(0, {work!r}); "
        "runpy.run_path({bridge!r}, run_name='__main__')"
    ).format(work=str(work), bridge=str(bridge))
    proc = subprocess.Popen(
        [sys.executable, "-u", "-c", shim, "--port", str(port)],
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
    bodies: list[str] = []  # every response body, for the password-leak scan at the end

    def check(name: str, ok: bool, detail: str = "") -> None:
        results.append((name, bool(ok), str(detail)))

    def getb(url: str) -> tuple[int, str]:
        code, body = get(url)
        bodies.append(body)
        return code, body

    def postb(url: str, payload: dict | None = None) -> tuple[int, str]:
        code, body = post(url, b"{}" if payload is None else json.dumps(payload).encode())
        bodies.append(body)
        return code, body

    out = ""
    try:
        print("=" * 70)
        print("BRIDGE HTTP LAYER - via a stub MetaTrader5, NOT a real broker")
        print("=" * 70)

        # (a) alive but NOT connected before any login. This also proves the v2 startup
        # order: v1 connected before binding, so on a stub-only machine the process would
        # already be dead and the readiness loop above would have failed.
        code, body = getb(base + "/health")
        d = json.loads(body)
        check(
            "health before login: alive, connected:false",
            code == 200 and d.get("ok") is True and d.get("connected") is False,
            body[:110],
        )

        # (f, first half) a FAILED login whose error echoes the password back — the reply
        # must name the failure but never the password
        code, body = postb(base + "/login", {"login": 424242, "password": "leak-me", "server": "StubServer"})
        d = json.loads(body)
        check(
            "failed login: named error, password scrubbed",
            code == 200 and d.get("ok") is False
            and "Authorization failed" in (d.get("error") or "")
            and "leak-me" not in body,
            (d.get("error") or "")[:100],
        )

        # fallback path: credentials rejected, but the terminal already runs THIS account,
        # so a bare attach to the same login is allowed by the contract
        code, body = postb(base + "/login", {"login": 424242, "password": "attach-only", "server": "StubServer"})
        d = json.loads(body)
        check(
            "login falls back to attach on an already-running same account",
            code == 200 and d.get("ok") is True,
            body[:110],
        )

        # (b) the REAL regression test for the v1 bug: the reply looks successful AND (see
        # the record assertions after shutdown) initialize() actually received the kwargs.
        # login is sent as a STRING to prove the bridge coerces it to int.
        code, body = postb(base + "/login", {"login": "424242", "password": "stub-secret", "server": "StubServer"})
        d = json.loads(body)
        shape_ok = (
            code == 200 and d.get("ok") is True
            and d.get("account") == "#424242"
            and d.get("server") == "StubServer"
            and bool(d.get("company"))
            and d.get("symbols") == 5
            and isinstance(d.get("startedByUs"), bool)
            and isinstance(d.get("hidden"), bool)
            and (d.get("terminalPid") is None or isinstance(d.get("terminalPid"), int))
        )
        # startedByUs/terminalPid/hidden VALUES depend on whether this machine happens to
        # have a real MetaTrader window open (the hider sweeps real windows) — only their
        # types and the stub-driven fields are machine-independent.
        check("login ok:true with account/server/company/symbols", shape_ok, body[:130])

        code, body = getb(base + "/health")
        d = json.loads(body)
        check(
            "health after login: connected, serverOffsetSeconds detected",
            d.get("connected") is True and d.get("account") == "#424242"
            and d.get("serverOffsetSeconds") == 7200,
            body[:130],
        )

        # symbols
        code, body = getb(base + "/symbols")
        d = json.loads(body)
        has_suffix_symbol = "EURUSD.m" in d.get("symbols", [])
        check(
            "symbols lists the broker's own names",
            code == 200 and len(d.get("symbols", [])) == 5 and has_suffix_symbol,
            f"{len(d.get('symbols', []))} symbols incl. EURUSD.m",
        )

        # timeframes
        code, body = getb(base + "/timeframes")
        d = json.loads(body)
        check(
            "timeframes are MT5's closed set",
            code == 200 and d.get("timeframes") == ["M1", "M5", "M15", "M30", "H1", "H4", "D1"],
            str(d.get("timeframes")),
        )

        # (c) the caller asks in TRUE UTC; the bridge must translate the request into the
        # stub's fake +7200 s server clock and shift the stamps back, so the first bar is
        # EXACTLY the UTC `from` the caller asked for, spacing exactly 60 s
        code, body = getb(base + "/candles?symbol=EURUSD&timeframe=M1&from=1704153600&to=1704239999")
        d = json.loads(body)
        cs = d.get("candles", [])
        ok = code == 200 and len(cs) == 1440
        shape_ok = ok and all(k in cs[0] for k in ("time", "open", "high", "low", "close", "volume"))
        shift_ok = shape_ok and cs[0]["time"] == 1704153600 and all(
            cs[i + 1]["time"] - cs[i]["time"] == 60 for i in range(len(cs) - 1)
        )
        check(
            "candles: 1440 bars with OHLCV, requested UTC window honored exactly",
            bool(shift_ok),
            f"{len(cs)} bars, first time {cs[0]['time'] if cs else None} (want {1704153600})",
        )

        # the suffix case a real user WILL hit
        code, body = getb(base + "/candles?symbol=NOPEUSD&timeframe=M1&from=1704153600&to=1704239999")
        d = json.loads(body)
        check(
            "unknown symbol gives a NAMED error, not an empty list",
            "not available at this broker" in (d.get("error") or ""),
            (d.get("error") or "")[:80],
        )

        # unknown timeframe
        code, body = getb(base + "/candles?symbol=EURUSD&timeframe=M7&from=1&to=2")
        d = json.loads(body)
        check(
            "unknown timeframe names the valid ones",
            "unknown timeframe" in (d.get("error") or "") and "M1" in (d.get("error") or ""),
            (d.get("error") or "")[:80],
        )

        # missing symbol
        code, body = getb(base + "/candles?timeframe=M1&from=1&to=2")
        d = json.loads(body)
        check("missing symbol is a 400", code == 400, (d.get("error") or "")[:60])

        # bad from/to
        code, body = getb(base + "/candles?symbol=EURUSD&timeframe=M1&from=abc&to=2")
        d = json.loads(body)
        check("non-numeric from/to is a 400", code == 400, (d.get("error") or "")[:60])

        # (e) READ-ONLY: no way to touch the account
        code, body = postb(base + "/orders")
        d = json.loads(body)
        check(
            "other POSTs are refused (405) - no account access",
            code == 405 and "read-only" in (d.get("error") or ""),
            f"{code} {(d.get('error') or '')[:40]}",
        )

        # CORS, because the app runs on a different origin
        req = urllib.request.Request(base + "/health")
        with urllib.request.urlopen(req, timeout=5) as r:
            cors = r.headers.get("Access-Control-Allow-Origin")
        check("CORS header present", cors == "*", str(cors))

        # unknown route
        code, body = getb(base + "/nope")
        check("unknown route is a 404", code == 404, str(code))

        # (d) shutdown: answers ok, then the PROCESS must actually exit
        code, body = postb(base + "/shutdown")
        check(
            "shutdown replies ok:true",
            code == 200 and json.loads(body).get("ok") is True,
            body[:60],
        )
        exited = False
        for _ in range(20):  # 5 s: the bridge caps its own cleanup at 3 s
            time.sleep(0.25)
            if proc.poll() is not None:
                exited = True
                break
        check("shutdown stops the server process", exited, f"exit code {proc.poll()}")

    finally:
        if proc.poll() is None:
            proc.kill()
        try:
            proc.wait(timeout=5)
        except Exception:
            pass
        out = proc.stdout.read() if proc.stdout else ""

    # (b, the recorded half) what the stub SAW initialize() receive — this is the evidence
    # for the v1 fix: password/server/login/timeout/path all reach the terminal call.
    events = []
    if record.exists():
        try:
            events = json.loads(record.read_text())
        except ValueError:
            events = []
    inits = [e.get("kwargs") or {} for e in events if e.get("call") == "initialize"]
    cred = [k for k in inits if k.get("password") == "stub-secret"]
    cred_ok = bool(cred) and (
        cred[0].get("login") == 424242
        and cred[0].get("server") == "StubServer"
        # 15 s per ATTEMPT: the login flow polls initialize() until a cold terminal is
        # ready, so the per-call timeout is short on purpose (the old single-shot 60 is
        # gone — see login_with_credentials)
        and cred[0].get("timeout") == 15
        and str(cred[0].get("path", "")).endswith("terminal64.exe")
    )
    check(
        "initialize() received login/password/server/path/timeout (v1 regression)",
        cred_ok,
        json.dumps(cred[0]) if cred else "no credential initialize recorded",
    )
    check(
        "attach fallback called initialize() with no credentials",
        any(len(k) == 0 for k in inits),
        f"{len(inits)} initialize calls recorded",
    )
    check(
        "mt5.shutdown() was called on POST /shutdown",
        any(e.get("call") == "shutdown" for e in events),
        f"{len(events)} recorded calls",
    )

    # (f, second half) the password never left the bridge process: not in any response
    # body, not in stdout/stderr. The record file is the stub's own observation and lives
    # in the temp dir — it is not a leak by the bridge.
    check(
        "password absent from every response and from captured output",
        all("stub-secret" not in b for b in bodies)
        and "stub-secret" not in out
        and "leak-me" not in out,
        f"{len(bodies)} responses scanned",
    )

    print()
    passed = 0
    for name, ok, detail in results:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name:58} {detail}")
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
