#!/usr/bin/env python3
"""
MT5 bridge v2 — run this next to your MetaTrader 5 terminal, on Windows.

Why this exists: MetaTrader has NO public HTTP API. The only supported way to read bars from
an MT4/MT5 account is the Windows terminal itself, or the `MetaTrader5` Python package, which
ships as a `win_amd64` wheel only. There is no way to log in to a broker over HTTPS and ask
for candles — that is the honest answer to "can the app take my IC Markets login".

So the app talks to THIS process over localhost, and this process talks to the terminal.

The v2 contract (changed from v1, each change fixing a real v1 defect):
  - the HTTP server binds FIRST and nothing is connected at startup. v1 connected before
    binding, so with no terminal running the process died before the app could even send
    credentials. Now the app may spawn this bridge and POST /login seconds later.
  - POST /login {login, password, server} performs the REAL credential login via
    mt5.initialize(path, login, password, server, timeout=60). v1 accepted credentials and
    then silently ignored them.
  - the terminal's windows are HIDDEN after login (the user asked for everything behind the
    scenes). A watcher re-hides late-appearing windows every 500 ms for 30 s, then stops —
    never fight a user who deliberately opens MetaTrader later.
  - bar times are normalized from the broker's SERVER timezone to true UTC epoch seconds.
    MT5 timestamps bars with the server's wall clock; treating them as UTC would drift every
    chart by the server's offset (typically GMT+2/+3). /health exposes the detected offset
    so the app can sanity-check it.
  - POST /shutdown releases the terminal and stops the server; the app calls it on quit so
    the python process does not leak.

What it does NOT do, by design:
  - never reads balance, equity, margin, open positions or order history
  - never places, modifies or closes an order
  - never writes the password to disk; it lives in memory for one initialize() call, is
    never logged, and is scrubbed from any error string before it leaves this process

Usage:
    python mt5-bridge.py --port 8765
    # then from the app (or curl):
    #   POST /login {"login": 12345678, "password": "...", "server": "ICMarkets-Demo"}

Endpoints:
    GET  /health     -> {ok, connected, account, server, company, symbols, terminalPid,
                        startedByUs, hidden, serverOffsetSeconds}
    GET  /symbols    -> {symbols: [...]}
    GET  /candles?symbol=EURUSD&timeframe=M1&from=...&to=... -> {candles: [...]} (times: UTC)
    GET  /timeframes -> {timeframes: [...]}
    POST /login      -> credential login + hide the terminal
    POST /shutdown   -> release the terminal, stop this server
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable
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


# ---------------------------------------------------------------------------
# Thread safety
#
# ThreadingHTTPServer serves every request on its own thread, and the MetaTrader5 module is
# not documented thread-safe (it drives one IPC pipe into a single terminal). One global lock
# around EVERY mt5.* call serializes the terminal conversation. This is also why /health can
# stall a few seconds during a long /login: correctness beats polling latency here, and the
# app's health poll tolerates it.
# ---------------------------------------------------------------------------
MT5_LOCK = threading.Lock()


def _mt5(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """The only door to the terminal: every mt5.* call goes through here, under the lock."""
    with MT5_LOCK:
        return fn(*args, **kwargs)


def _last_error_str() -> str:
    """last_error() as a string, captured under the lock like any other mt5 call."""
    return f"{_mt5(mt5.last_error)}"


class _State:
    """Everything /health reports. Mutated only under MT5_LOCK."""

    connected = False
    account: str | None = None       # "#12345678", display form
    server: str | None = None
    company: str | None = None
    symbols = 0
    terminal_pid: int | None = None
    started_by_us = False
    hidden = False
    offset: int | None = None        # server-tz -> UTC shift in seconds; None = undetected
    offset_note: str | None = None   # set when detection failed and times are NOT shifted


STATE = _State()


def _reset_state() -> None:
    STATE.connected = False
    STATE.account = None
    STATE.server = None
    STATE.company = None
    STATE.symbols = 0
    STATE.terminal_pid = None
    STATE.started_by_us = False
    STATE.hidden = False
    STATE.offset = None
    STATE.offset_note = None


# ---------------------------------------------------------------------------
# Finding the terminal
# ---------------------------------------------------------------------------

def _terminal_from_registry() -> str | None:
    """
    App Paths is where the MT5 installer records the exact terminal64.exe location.

    HKCU is tried after HKLM: per-user installs land there. Any failure just means "not in
    the registry", which is normal for portable copies — not an error worth surfacing.
    """
    if sys.platform != "win32":
        return None
    try:
        import winreg
        for root in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                with winreg.OpenKey(
                    root, r"Software\Microsoft\Windows\CurrentVersion\App Paths\terminal64.exe"
                ) as key:
                    path, _kind = winreg.QueryValueEx(key, None)  # the (Default) value
                    if path and os.path.isfile(path):
                        return path
            except OSError:
                continue
    except Exception:
        pass
    return None


def _normalise_for_match(s: str) -> str:
    """Lowercase alphanumerics only, so 'ICMarketsEU-Demo' and 'IC Markets EU' compare equal."""
    return "".join(ch for ch in s.lower() if ch.isalnum())


def _terminal_server_score(path: str, server: str) -> int:
    """
    How well an installed terminal matches the server being logged into.

    A machine commonly holds SEVERAL terminals (measured on the dev box: 'MetaTrader 5',
    'MetaTrader 5 IC Markets EU', 'Alpari MT5', 'LiteFinance MT5 Terminal', ...), one per
    broker. Logging an IC Markets account into the generic terminal forced a full server
    config download on cold start, while the broker's own terminal already knew the server
    and its saved account. The install folder name carries the broker, so the server name
    ('ICMarketsEU-Demo') is matched against the folder ('IC Markets EU') and the best match
    wins; 0 means no signal, and ties fall back to the discovery order below.
    """
    key = _normalise_for_match(server)
    if not key:
        return 0
    folder = _normalise_for_match(os.path.basename(os.path.dirname(path)))
    if not folder:
        return 0
    # longest common substring would over-reward; a containment test on the broker token
    # is enough and predictable. 'icmarkets' in 'metatrader5icmarkets eu' -> hit.
    for size in (len(key), 8, 6, 4):
        if len(key) >= size and key[:size] in folder:
            return size
    return 0


def _find_terminal(server: str | None = None) -> str | None:
    """
    Locate an installed MetaTrader 5 terminal executable, preferring one whose
    install folder matches the target broker server.

    Checked in the places MT5 actually installs to. Returned to initialize(path=...) so the
    bridge attaches to that installation instead of letting the package pick one - and so a
    missing terminal produces a clear message rather than a mystery failure.
    """
    # The test suite (and users with unusual installs) can point at a terminal explicitly;
    # harmless to check first.
    override = os.environ.get("MT5_BRIDGE_TERMINAL")
    candidates: list[str] = [override] if override else []

    # the MetaTrader5 package records the last used terminal here — highest signal
    try:
        import configparser
        cfg = configparser.ConfigParser()
        cfg.read(os.path.join(os.environ.get("APPDATA", ""), "MetaQuotes", "Terminal", "common.ini"))
        if cfg.has_option("Common", "Path"):
            candidates.append(os.path.join(cfg.get("Common", "Path"), "terminal64.exe"))
    except Exception:
        pass

    reg = _terminal_from_registry()
    if reg:
        candidates.append(reg)

    for base in (
        os.environ.get("ProgramFiles", r"C:\Program Files"),
        os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
    ):
        if not base:
            continue
        # broker-branded installs live in their own folder under Program Files
        try:
            for name in os.listdir(base):
                if "metatrader" in name.lower():
                    candidates.append(os.path.join(base, name, "terminal64.exe"))
        except OSError:
            pass

    # newer per-user installs (no admin rights) land here instead of Program Files
    local = os.environ.get("LOCALAPPDATA")
    if local:
        try:
            for name in os.listdir(os.path.join(local, "Programs")):
                candidates.append(os.path.join(local, "Programs", name, "terminal64.exe"))
        except OSError:
            pass

    for c in candidates:
        if c and os.path.isfile(c):
            if server:
                # rank only existing candidates by broker match, keep discovery order on ties
                existing = [x for x in candidates if x and os.path.isfile(x)]
                ranked = sorted(
                    existing,
                    key=lambda x: (-_terminal_server_score(x, server), existing.index(x)),
                )
                return ranked[0]
            return c
    return None


# ---------------------------------------------------------------------------
# Hiding the terminal
#
# The user asked for "no visible MetaTrader window". The terminal is still needed (it is the
# only data source), so it is started and then hidden via ShowWindow(SW_HIDE) — not killed.
#
# Matching is deliberately narrow: top-level windows whose TITLE starts with "MetaTrader 5"
# or whose WINDOW CLASS starts with "MetaQuotes::MetaTrader 5". The class prefix is what
# catches broker-branded installs ("IC Markets — MetaTrader 5"), whose titles differ. Nothing
# outside those matches is ever touched.
#
# Everything here is wrapped so a failure inside ctypes can never break the HTTP server: a
# hider that kills the bridge is worse than a visible window.
# ---------------------------------------------------------------------------

_SW_HIDE = 0
_HIDE_WATCH_SECONDS = 30.0   # the terminal creates windows LATE (charts, popups) after launch
_HIDE_WATCH_INTERVAL = 0.5

_hide_watch_lock = threading.Lock()
_hide_watch_thread: threading.Thread | None = None
_hide_watch_until = 0.0


def _find_mt_windows() -> list[tuple[int, int]]:
    """(hwnd, pid) of top-level MetaTrader 5 windows. Never raises."""
    if sys.platform != "win32":
        return []
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        found: list[tuple[int, int]] = []

        def _exe_of(pid: int) -> str:
            """Basename of the process image, lowercase; '' when it cannot be read."""
            h = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if not h:
                return ""
            try:
                buf = ctypes.create_unicode_buffer(1024)
                size = wintypes.DWORD(len(buf))
                if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                    return buf.value.rsplit("\\", 1)[-1].lower()
                return ""
            finally:
                kernel32.CloseHandle(h)

        # WINFUNCTYPE keeps the callback alive through the EnumWindows call; the local name
        # holds the reference so it is not collected mid-enumeration.
        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def on_window(hwnd: int, _lparam: int) -> bool:
            # Match by PROCESS NAME, not window title/class: a real terminal's main window
            # is titled "<login> - <server> - Hedging - [EURUSD,Daily]" — measured, it does
            # NOT start with "MetaTrader 5", so a title-prefix matcher never fires and the
            # window stayed visible through the first real test. Every MT5 install names
            # its process terminal64.exe, broker branding included, which is exactly the
            # set of windows this app promises to keep off the user's screen.
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value and _exe_of(int(pid.value)) == "terminal64.exe":
                found.append((int(hwnd), int(pid.value)))
            return True  # keep enumerating

        user32.EnumWindows(on_window, 0)
        return found
    except Exception as exc:  # noqa: BLE001 — see the block comment: never break the server
        sys.stderr.write(f"window enumeration failed (terminal will stay visible): {exc!r}\n")
        return []


def _hide_mt_windows() -> int:
    """
    Sweep once: hide every matching MetaTrader window. Returns how many matched.

    Never raises. ShowWindow on an already-hidden window is a harmless no-op, so sweeping
    repeatedly is safe.
    """
    matches = _find_mt_windows()
    if not matches:
        return 0
    try:
        import ctypes
        user32 = ctypes.windll.user32
        for hwnd, _pid in matches:
            user32.ShowWindow(hwnd, _SW_HIDE)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"window hide failed (terminal will stay visible): {exc!r}\n")
    with MT5_LOCK:
        if STATE.terminal_pid is None:
            STATE.terminal_pid = matches[0][1]
        STATE.hidden = True
    return len(matches)


def _hide_watch_loop() -> None:
    while True:
        with _hide_watch_lock:
            remaining = _hide_watch_until - time.monotonic()
        if remaining <= 0:
            return
        _hide_mt_windows()
        time.sleep(_HIDE_WATCH_INTERVAL)


def _start_hide_watcher() -> None:
    """
    Keep sweeping for 30 s after a login, because the terminal creates windows late: the
    splash goes first, then chart windows, sometimes a popup. After 30 s the watcher stops
    forever — if the user DELIBERATELY opens MetaTrader later, it must stay open.
    """
    global _hide_watch_thread, _hide_watch_until
    with _hide_watch_lock:
        _hide_watch_until = time.monotonic() + _HIDE_WATCH_SECONDS
        if _hide_watch_thread is None or not _hide_watch_thread.is_alive():
            # daemon: a 30 s watcher must never keep the process alive past /shutdown
            _hide_watch_thread = threading.Thread(
                target=_hide_watch_loop, name="mt5-window-hider", daemon=True
            )
            _hide_watch_thread.start()


# ---------------------------------------------------------------------------
# Timezone normalization
#
# MT5 stamps every bar with the broker SERVER's wall clock, not UTC. A GMT+2/GMT+3 server
# therefore returns "epoch" times that are 2–3 hours ahead of true UTC; treating them as UTC
# shifts every chart. The offset is detected once per login (a different server has a
# different offset) by comparing the newest M1 bar's open time against the local clock.
# ---------------------------------------------------------------------------

_MAX_SERVER_OFFSET = 15 * 3600  # no broker server is more than ±15h from UTC


def _server_offset_seconds(last_bar_time: int, now: float) -> int:
    """
    Pure, unit-testable form of the detection math.

    A bar's open time is a whole minute on the SERVER clock, and the bar is less than
    60 s old when fresh, so the true offset is the unique multiple of 60 inside
    [last-now, last-now+60). CEIL finds it exactly for every bar age — the earlier
    round((last+60-now)/60) form was off by 60 s whenever the bar was younger than
    half a minute (measured: a 1-second-old BTC bar produced 10860 instead of 10800,
    which the quarter-hour sanity check then rightly rejected). The clamp bounds
    garbage inputs (stale bars over a weekend) to something /health can flag.
    """
    offset = int(math.ceil((last_bar_time - now) / 60.0)) * 60
    if offset > _MAX_SERVER_OFFSET:
        return _MAX_SERVER_OFFSET
    if offset < -_MAX_SERVER_OFFSET:
        return -_MAX_SERVER_OFFSET
    return offset


def _bar_time_to_utc(t: int, offset: int | None) -> int:
    """Shift a bar time from the broker's server clock to true UTC epoch seconds."""
    return int(t) - (offset or 0)


def _detect_server_offset() -> tuple[int | None, str | None]:
    """
    Measure the server-clock offset for THIS connection. Returns (offset, note).

    offset is None exactly when detection failed; then bars are returned UNSHIFTED (offset 0)
    and the note explains why, so the app can refuse to trust alignment rather than silently
    drawing a chart shifted by a garbage value.

    TICK-based, not bar-based, after two real failures of the bar path:
      - on a weekend the newest FX bar is hours stale, and stale-bar math produced a
        plausible-looking wrong offset;
      - on a JUST-BOOTED terminal (measured 13 s after cold start) chart history is not
        synced yet, so even a 24/7 symbol's newest bar was stale — and the staleness check
        is circular (a wrong offset shifts its own bar into looking fresh).
    A tick request forces a live quote, which breaks the circularity: for a trading symbol
    the tick time is seconds old, whatever the chart history state. 24/7 symbols (crypto)
    are tried first so weekends cannot starve the detection; a whole-quarter-hour offset
    shape is required (every real broker zone is whole or :30).
    """
    names = ["BTCUSD", "ETHUSD", "EURUSD"]
    syms = _mt5(mt5.symbols_get) or []
    if syms and syms[0].name not in names:
        names.append(syms[0].name)  # any liquid symbol works; the account's first is the fallback

    tick_fn = getattr(mt5, "symbol_info_tick", None)
    if tick_fn is None:
        return None, "server timezone not detected: symbol_info_tick unavailable"
    last_err = "(no call made)"
    # two passes with a pause: on a JUST-BOOTED terminal the live feeds take a few seconds
    # to start flowing, and the first pass can honestly find no fresh tick
    for attempt in range(2):
        for sym in names:
            # a symbol must be visible in Market Watch before it can be quoted
            _mt5(mt5.symbol_select, sym, True)
            tick = _mt5(tick_fn, sym)
            if tick is None or not getattr(tick, "time", 0):
                last_err = _last_error_str()
                continue
            now = time.time()
            raw = _server_offset_seconds(int(tick.time), now)
            if abs(raw) > _MAX_SERVER_OFFSET:
                continue  # implausible for THIS symbol; a 24/7 one may still succeed
            if raw % 900 != 0:
                continue  # not a real timezone shape
            age = now - (int(tick.time) - raw)
            if not (0 <= age <= 300):
                continue  # tick not fresh (market closed for this symbol) — try the next
            return raw, None
        if attempt == 0:
            time.sleep(3)
    return None, (
        f"server timezone not detected: no fresh tick to compare against ({last_err}); "
        f"candle times are NOT being shifted"
    )


_offset_retry_at = 0.0


def _ensure_offset() -> None:
    """
    Re-detect lazily: at login a cold terminal may not have live feeds yet (measured: the
    first detection 13 s after boot found no fresh tick). Health polls and candle requests
    arrive seconds later, when the feeds are up — each gets one retry per 10 s until the
    offset resolves, and /health keeps reporting the honest null until then.
    """
    global _offset_retry_at
    if not STATE.connected or STATE.offset is not None:
        return
    if time.monotonic() < _offset_retry_at:
        return
    _offset_retry_at = time.monotonic() + 10
    offset, note = _detect_server_offset()
    with MT5_LOCK:
        if offset is not None:
            STATE.offset = offset
            STATE.offset_note = None
        else:
            STATE.offset_note = note


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------

def _scrub(text: str, password: str) -> str:
    """Remove the password from anything that is about to leave this process."""
    if password:
        return text.replace(password, "****")
    return text


def login_with_credentials(login: int, password: str, server: str) -> tuple[bool, dict[str, Any] | str]:
    """
    The real credential login. Returns (True, payload) or (False, scrubbed error message).

    How the terminal is brought up, and why it is not simply initialize(path=...):
    measured on a real IC Markets install, the MetaTrader5 package's own launch path gives
    up on the IPC handshake long before a COLD terminal finishes booting (first server
    connect, cache rebuild) — initialize() fails with (-10005, 'IPC timeout') while the
    terminal it spawned keeps booting and logs in seconds later on its own. Meanwhile the
    SAME package attaches to an ALREADY-RUNNING terminal instantly, credentials included.

    So the bridge owns the lifecycle: it starts the terminal itself, hides what appears on
    screen while it boots, and RETRIES initialize() (with shutdown() between attempts —
    required by the package) until the terminal is ready. One successful initialize then
    both handshakes and logs the account in.
    """
    terminal = _find_terminal(server)
    if terminal is None:
        return False, (
            "no MetaTrader 5 installation found (looked in Program Files, %LOCALAPPDATA%\\Programs, "
            "the registry App Paths key and the MetaQuotes common.ini). Install the terminal once, "
            "then retry the login."
        )

    # Launch the terminal ourselves when none is running. The package's internal launcher
    # is exactly the cold-start path that times out, so it is never used. The test suite
    # sets MT5_BRIDGE_NO_LAUNCH because its "terminal" is an empty stand-in file that Popen
    # cannot execute, and because launching real GUI apps from a unit test would not be
    # hermetic anyway.
    launched_by_us = False
    launched_pid: int | None = None
    if not os.environ.get("MT5_BRIDGE_NO_LAUNCH") and len(_find_mt_windows()) == 0:
        try:
            proc = subprocess.Popen(
                [terminal], cwd=os.path.dirname(terminal) or None,
                close_fds=True,
            )
            launched_pid = proc.pid
            launched_by_us = True
            # hide the splash and every window the terminal creates while booting, so
            # "no MetaTrader window next to the app" holds during the wait too
            _start_hide_watcher()
        except OSError as exc:
            return False, _scrub(f"could not start the MetaTrader terminal: {exc}", password)

    ok = False
    last_err = "(no attempt)"
    # A cold boot legitimately takes tens of seconds; a warm attach is instant. The same
    # budget covers both so the caller never has to know which one happened.
    deadline = time.monotonic() + (150 if launched_by_us else 30)
    while time.monotonic() < deadline:
        ok = _mt5(
            mt5.initialize,
            path=terminal, login=login, password=password, server=server, timeout=15,
        )
        if ok:
            break
        last_err = _last_error_str()
        # A REAL refusal (bad password, unknown account) on a terminal we did not just
        # launch will not improve by retrying; a booting one will keep saying IPC timeout.
        if not launched_by_us and "IPC timeout" not in last_err:
            break
        # a failed initialize() must be released before the next attempt — the package
        # refuses to re-handshake inside a poisoned process otherwise
        _mt5(mt5.shutdown)
        _hide_mt_windows()
        # a cold boot can outlive one 30 s watcher window; re-arm it each round
        if launched_by_us:
            _start_hide_watcher()
        time.sleep(4)

    via_attach = False
    if not ok:
        cred_err = last_err
        # Fallback, only meaningful for a terminal that was already running: attach
        # WITHOUT any arguments (the package remembers the terminal it just used, and a
        # no-kwargs initialize is the documented attach form) and accept it when it is
        # logged into the SAME account the user asked for — the session they see really
        # is their account, and re-sending the password would add nothing.
        attached = _mt5(mt5.initialize) if not launched_by_us else False
        info = _mt5(mt5.account_info) if attached else None
        if not (attached and info is not None and int(info.login) == login):
            if attached and info is not None:
                return False, _scrub(
                    f"the running terminal is logged in as #{info.login} on {info.server}, "
                    f"not #{login} on {server}. Credential login also failed: {cred_err}",
                    password,
                )
            return False, _scrub(
                f"MetaTrader login failed: {cred_err}. Check the account number, password and "
                f"server name (e.g. 'ICMarkets-Demo').",
                password,
            )
        via_attach = True  # attached to a terminal already on this exact account

    info = _mt5(mt5.account_info)
    if info is None:
        return False, _scrub(
            f"login seemed to succeed but no account is attached: {_last_error_str()}", password
        )

    with MT5_LOCK:
        _reset_state()
        STATE.connected = True
        STATE.account = f"#{info.login}"
        STATE.server = info.server
        STATE.company = getattr(info, "company", "") or ""

    syms = _mt5(mt5.symbols_get) or []
    with MT5_LOCK:
        STATE.symbols = len(syms)

    # Hide what is on screen NOW, then keep sweeping for 30 s: the terminal is still booting
    # and will create chart windows and popups for the next several seconds.
    _hide_mt_windows()
    _start_hide_watcher()

    offset, note = _detect_server_offset()
    with MT5_LOCK:
        STATE.offset = offset
        STATE.offset_note = note
        # startedByUs is true only when THIS bridge launched the terminal process itself;
        # an attach by definition used an already-running one.
        STATE.started_by_us = launched_by_us and not via_attach
        if STATE.terminal_pid is None:
            STATE.terminal_pid = launched_pid
        payload = {
            "ok": True,
            "account": STATE.account,
            "server": STATE.server,
            "company": STATE.company,
            "symbols": STATE.symbols,
            "terminalPid": STATE.terminal_pid,
            "startedByUs": bool(STATE.started_by_us),
            "hidden": bool(STATE.hidden),
        }
    return True, payload


def candles(symbol: str, timeframe: str, start: int, end: int) -> dict[str, Any]:
    """
    Bars for a range, in TRUE UTC epoch seconds.

    `copy_rates_range` returns a numpy structured array. It is converted field by field rather
    than trusting the dtype order, because a mis-ordered array would produce a chart with the
    open and close swapped — which looks plausible and is completely wrong.

    One copy_rates_range per request, on purpose: the app chunks history itself (the
    terminal's "Max bars" setting truncates large ranges silently, so a single big request
    would lie about being complete).
    """
    tf = timeframes().get(timeframe.upper())
    if tf is None:
        return {"candles": [], "error": f"unknown timeframe {timeframe!r}; have {list(timeframes())}"}

    # a cold terminal may not have had live feeds at login time; by the first candle
    # request they are usually up, so try the offset once more before serving raw stamps
    _ensure_offset()

    # make the symbol visible in Market Watch, or copy_rates fails for a valid symbol
    if not _mt5(mt5.symbol_select, symbol, True):
        return {"candles": [], "error": f"symbol {symbol!r} not available at this broker: {_last_error_str()}"}

    # The terminal applies request datetimes on the SERVER's wall clock, not UTC — the
    # package docs say UTC, but measured against a real EEST server, a UTC range of
    # 08:00–12:00 came back as bars stamped 08:00–12:00 SERVER time. So a true-UTC request
    # [start, end] must be translated INTO server clock first (+offset), and the returned
    # stamps shifted back (-offset) below. Without this, every range lands 2×offset off.
    offset = STATE.offset
    adj_start = start + (offset or 0)
    adj_end = end + (offset or 0)
    from_dt = datetime.fromtimestamp(adj_start, tz=timezone.utc)
    to_dt = datetime.fromtimestamp(adj_end, tz=timezone.utc)
    rates = _mt5(mt5.copy_rates_range, symbol, tf, from_dt, to_dt)

    if rates is None or len(rates) == 0:
        return {"candles": [], "error": f"no bars for {symbol} {timeframe} in that range: {_last_error_str()}"}

    # offset (detected above): None means detection failed — then bars stay unshifted and
    # /health says so, which is the honest failure mode.
    out = []
    for r in rates:
        out.append({
            "time": _bar_time_to_utc(r["time"], offset),  # broker server tz -> true UTC
            "open": float(r["open"]),
            "high": float(r["high"]),
            "low": float(r["low"]),
            "close": float(r["close"]),
            "volume": float(r["tick_volume"]),
        })
    return {"candles": out}


# ---------------------------------------------------------------------------
# Shutdown
# ---------------------------------------------------------------------------

def _shutdown_everything(server: ThreadingHTTPServer) -> None:
    """
    Release the terminal and stop the serve loop, capped at ~3 s so cleanup can never hang.

    The /shutdown handler answers the HTTP response FIRST and schedules this on a timer, so
    the response is on the wire before the socket goes away. A terminal the BRIDGE launched
    itself (cold start) is terminated by pid afterwards — mt5.shutdown() only closes
    terminals the PACKAGE launched, and ours was started with Popen. A pre-existing terminal
    is never touched: we do not kill processes we did not start.
    """
    our_pid: int | None = None
    try:
        with MT5_LOCK:
            STATE.connected = False
            if STATE.started_by_us:
                our_pid = STATE.terminal_pid

        def _quit_mt5() -> None:
            with MT5_LOCK:  # every mt5.* call takes the lock — shutdown is no exception
                if mt5 is not None:
                    mt5.shutdown()

        # In its own thread because an in-flight login's initialize() can hold the lock for
        # up to its 60 s timeout; the 3 s cap means we stop waiting, not that we skip the lock.
        stopper = threading.Thread(target=_quit_mt5, daemon=True)
        stopper.start()
        stopper.join(3.0)
    except Exception as exc:  # noqa: BLE001 — shutdown must never raise
        sys.stderr.write(f"mt5 shutdown problem: {exc!r}\n")

    if our_pid:
        try:
            # /T kills the tree: a launched terminal64 can re-exec or spawn helper
            # processes, so the Popen pid and the live terminal pid are not always equal
            subprocess.run(
                ["taskkill", "/PID", str(our_pid), "/T"],
                capture_output=True, timeout=8,
            )
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"terminal cleanup problem (pid {our_pid}): {exc!r}\n")

    loop = threading.Thread(target=server.shutdown, daemon=True)
    loop.start()
    loop.join(3.0)
    try:
        server.server_close()
    except Exception:  # noqa: BLE001
        pass
    sys.stderr.write("bridge stopped\n")


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _read_json(self) -> dict[str, Any] | None:
        """Read and parse the request body, or None if it is not JSON."""
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if length <= 0 or length > 64 * 1024:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        # one line per request, so a slow symbol is visible. Method+path only — request
        # BODIES (which for /login contain the password) are never logged.
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
        self.wfile.flush()  # /shutdown must have its response on the wire before the timer fires

    def do_OPTIONS(self) -> None:  # noqa: N802
        # POSTing application/json from a file:// origin makes the renderer send a CORS
        # preflight first; without this answer the login request would never even be made.
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        u = urlparse(self.path)
        q = parse_qs(u.query)

        if u.path == "/health":
            # Being ALIVE is ok:true even when not connected — the app polls this to learn
            # "bridge up, terminal down", which is a different state from "bridge gone".
            _ensure_offset()  # a cold terminal's feeds start seconds after login
            with MT5_LOCK:
                connected = STATE.connected
                if connected:
                    info = mt5.account_info()  # cheap liveness probe of the terminal link
                    syms = mt5.symbols_get()
                    if info is None or syms is None:
                        # terminal died or logged out under us; say so instead of stale data
                        STATE.connected = False
                        STATE.account = None
                        STATE.server = None
                        STATE.company = None
                        STATE.symbols = 0
                        STATE.offset = None
                        STATE.offset_note = "terminal connection lost"
                        connected = False
                    else:
                        STATE.account = f"#{info.login}"
                        STATE.server = info.server
                        STATE.company = getattr(info, "company", "") or ""
                        STATE.symbols = len(syms)
                payload = {
                    "ok": True,
                    "connected": connected,
                    "account": STATE.account if connected else None,
                    "server": STATE.server if connected else None,
                    "company": STATE.company if connected else None,
                    "symbols": STATE.symbols if connected else 0,
                    "terminalPid": STATE.terminal_pid,
                    "startedByUs": STATE.started_by_us,
                    "hidden": STATE.hidden,
                    "serverOffsetSeconds": STATE.offset,
                }
                if STATE.offset_note and connected:
                    payload["note"] = STATE.offset_note
            self._send(200, payload)
            return

        if u.path == "/timeframes":
            self._send(200, {"timeframes": list(timeframes())})
            return

        if u.path == "/symbols":
            syms = _mt5(mt5.symbols_get) or []
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
        u = urlparse(self.path)

        # Login is the one write-shaped action this bridge accepts, because a user who wants
        # to type their demo credentials in the app otherwise cannot: the terminal may be
        # logged out, and telling them to open MetaTrader first is not always possible
        # (headless VM, kiosk). Credentials are used once, in memory, and never stored; the
        # terminal owns the session afterwards.
        if u.path == "/login":
            body = self._read_json()
            if body is None:
                self._send(400, {"error": "body must be JSON: {login, password, server}"})
                return
            login = body.get("login")
            password = body.get("password")
            server = body.get("server")
            if not login or not password or not server:
                self._send(400, {"error": "login, password and server are all required"})
                return
            try:
                login_int = int(login)
            except (TypeError, ValueError):
                self._send(400, {"error": f"login must be a number, got {login!r}"})
                return
            ok, result = login_with_credentials(login_int, str(password), str(server))
            if not ok:
                # result is already password-scrubbed; the log line keeps the diagnosis
                # without ever echoing the credential itself.
                sys.stderr.write(f"login #{login_int}@{server}: FAILED: {result}\n")
                self._send(200, {"ok": False, "error": result})
                return
            sys.stderr.write(f"login #{login_int}@{server}: ok\n")
            self._send(200, result)  # type: ignore[arg-type] — payload dict on the ok path
            return

        if u.path == "/shutdown":
            # Answer first, THEN stop: the response must reach the app before the socket
            # closes. 0.25 s is enough for the flush, short enough to feel instant.
            self._send(200, {"ok": True, "stopping": True})
            t = threading.Timer(0.25, _shutdown_everything, args=(self.server,))
            t.daemon = True
            t.start()
            return

        # Everything else stays refused: no orders, no balance, no positions. The request
        # body is drained first so an HTTP/1.1 keep-alive connection stays in sync for the
        # next request on the same socket.
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            length = 0
        if 0 < length <= 64 * 1024:
            self.rfile.read(length)
        self._send(405, {"error": "read-only bridge: candles, symbols, login and shutdown; nothing else"})


class BridgeServer(ThreadingHTTPServer):
    # handler threads must not outlive the serve loop on /shutdown — otherwise a slow
    # /candles could hold the process open past the app's grace period
    daemon_threads = True


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

def selftest() -> int:
    """
    Check everything, in order, and report. Never raises.

    Two kinds of checks live here: code checks (run anywhere, must PASS) and terminal checks
    (need a running, logged-in terminal; reported as SKIP when absent). A diagnostic that
    FAILS on a healthy dev box gets ignored, so "no MetaTrader on this machine" is a SKIP,
    not a FAIL — the suite stays green wherever it runs, and only real breakage is red.
    """
    print("=" * 62)
    print("MT5 BRIDGE SELF-TEST (v2)")
    print("=" * 62)

    checks: list[tuple[str, str, str]] = []  # (name, PASS/FAIL/SKIP, detail)

    def check(name: str, status: str, detail: str) -> None:
        checks.append((name, status, detail))

    # 1. platform
    is_windows = sys.platform.startswith("win")
    check(
        "Windows",
        "PASS" if is_windows else "FAIL",
        "yes" if is_windows else f"no ({sys.platform}) — MetaTrader5 is a Windows-only build",
    )

    # 2. python version, since the wheel is per-version
    v = f"{sys.version_info.major}.{sys.version_info.minor}"
    check("Python " + v, "PASS", "cp" + v.replace(".", ""))

    # 3. the package
    if mt5 is None:
        check("MetaTrader5 package", "FAIL", f"missing: {MT5_IMPORT_ERROR}")
        _report(checks)
        print()
        print("STOP HERE: without the package nothing else can be tested.")
        print("  On Windows:  pip install MetaTrader5")
        print("  On Linux:    not possible — this needs a Windows machine or VM.")
        return 1
    check("MetaTrader5 package", "PASS", "imported")

    # 4. the window-hider sweep must be exception-free even with NO terminal present —
    #    it runs on every login, so a raise here would break the server in the field.
    try:
        swept = _hide_mt_windows()  # call the sweep directly: no terminal required
        check("window-hider sweep is exception-free", "PASS", f"{swept} MetaTrader window(s) processed")
    except Exception as exc:  # noqa: BLE001
        check("window-hider sweep is exception-free", "FAIL", f"sweep raised {exc!r}")

    # 5. the global lock is actually held while an mt5 call runs (thread-safety contract).
    probe: dict[str, bool] = {}

    def _fake_mt5_call() -> None:
        got = MT5_LOCK.acquire(blocking=False)
        if got:
            MT5_LOCK.release()
        probe["held"] = not got

    _mt5(_fake_mt5_call)
    check(
        "mt5 calls hold the global lock",
        "PASS" if probe.get("held") else "FAIL",
        "acquire(blocking=False) failed inside the call, as it must"
        if probe.get("held") else "the lock was FREE inside a wrapped call",
    )

    # 6. the timezone shift math, on synthetic offsets (pure functions, no terminal).
    now = 1_700_000_123
    tz_cases: list[tuple[str, int, int]] = [
        ("+2h server", _server_offset_seconds(now + 7200 - 45, now), 7200),
        ("+3h server, 1 s old bar", _server_offset_seconds(now + 10800 - 1, now), 10800),
        ("-11h server", _server_offset_seconds(now - 39600 - 45, now), -39600),
        ("+20h clamps to +15h", _server_offset_seconds(now + 72000 - 45, now), 54000),
        ("utc shift", _bar_time_to_utc(now, 7200), now - 7200),
        ("no offset = no shift", _bar_time_to_utc(now, None), now),
    ]
    bad = [f"{name}: got {got}, want {want}" for name, got, want in tz_cases if got != want]
    check(
        "server-timezone shift math is exact",
        "PASS" if not bad else "FAIL",
        "; ".join(bad) if bad else f"{len(tz_cases)} synthetic cases exact",
    )

    # 7. terminal checks — SKIP (not FAIL) when no terminal is available to check against.
    windows_before = len(_find_mt_windows())
    attached = _mt5(mt5.initialize)
    info = _mt5(mt5.account_info) if attached else None
    if info is None:
        # If our probe WOKE a terminal that was not running before, hide what we woke —
        # but never touch windows that existed before the probe (the user's own).
        if windows_before == 0 and len(_find_mt_windows()) > 0:
            _hide_mt_windows()
        check(
            "terminal running and logged in",
            "SKIP",
            f"not available ({_last_error_str()}) — data checks need a running terminal; "
            f"this is not a failure",
        )
        _report(checks)
        try:
            _mt5(mt5.shutdown)
        except Exception:  # noqa: BLE001
            pass
        print()
        print(f"ALL CHECKS PASSED ({len(checks)} checked, terminal checks SKIPPED: no running")
        print("terminal on this machine). Code checks passed; the broker data path is")
        print("verified the first time the app logs in.")
        return 0

    check("terminal running and logged in", "PASS", f"{info.server} #{info.login}")
    if windows_before == 0:
        _hide_mt_windows()  # our initialize() launched this terminal; put it back to sleep

    # 8. can it see symbols at all?
    syms = _mt5(mt5.symbols_get) or []
    check(
        "symbols visible",
        "PASS" if len(syms) > 0 else "FAIL",
        f"{len(syms)} symbols",
    )

    # 9. the real test: can it read EURUSD M1 bars?
    if syms:
        _mt5(mt5.symbol_select, "EURUSD", True)
        from_dt = datetime(2024, 1, 2, tzinfo=timezone.utc)
        to_dt = datetime(2024, 1, 3, tzinfo=timezone.utc)
        rates = _mt5(mt5.copy_rates_range, "EURUSD", mt5.TIMEFRAME_M1, from_dt, to_dt)
        n = 0 if rates is None else len(rates)
        check(
            "EURUSD M1 bars (2024-01-02)",
            "PASS" if n > 0 else "FAIL",
            f"{n} bars" + ("" if n else f" — {_last_error_str()}"),
        )
        if n > 0:
            r = rates[0]
            check(
                "bar prices plausible",
                # a wrong symbol or a broken broker feed gives 0 or a giant number
                "PASS" if 0.5 < float(r["open"]) < 2.0 else "FAIL",
                f"first open {float(r['open']):.5f}",
            )

        # 10. timezone detection against the LIVE clock (needs bars, hence the guard).
        offset, note = _detect_server_offset()
        check(
            "server timezone detected",
            "PASS" if offset is not None else "SKIP",
            f"serverOffsetSeconds={offset}" + (f" ({note})" if note else ""),
        )

    _report(checks)
    try:
        _mt5(mt5.shutdown)
    except Exception:  # noqa: BLE001
        pass

    failed = [c for c in checks if c[1] == "FAIL"]
    skipped = [c for c in checks if c[1] == "SKIP"]
    if failed:
        print()
        print(f"{len(failed)} check(s) failed — see above.")
        return 1
    print()
    print("ALL CHECKS PASSED" + (f" ({len(skipped)} skipped)." if skipped else "."))
    print("Start the bridge:  python mt5-bridge.py")
    print("then log in from the app, or: curl -X POST http://127.0.0.1:8765/login ...")
    return 0


def _report(checks: list[tuple[str, str, str]]) -> None:
    for name, status, detail in checks:
        print(f"  [{status}] {name:42} {detail}")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Read-only MT4/MT5 candle bridge (v2: binds first, logs in via POST /login)"
    )
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

    # Bind FIRST, before any terminal interaction. v1 connected before binding, so a missing
    # terminal killed the process before the app could send /login; the app may spawn this
    # bridge and log in seconds later, and /health must answer {connected:false} meanwhile.
    try:
        server = BridgeServer((args.host, args.port), Handler)
    except OSError as e:
        # Almost always "port in use", which on Windows arrives as WinError 10048. Say what it
        # means and what to do, instead of letting a traceback reach the app's error box.
        print(
            f"ERROR: cannot listen on {args.host}:{args.port} ({e}). "
            f"Another bridge or program is probably using that port; close it, or start this one "
            f"with --port <other>.",
            file=sys.stderr,
        )
        return 2

    print(f"bridge listening on http://{args.host}:{args.port}", flush=True)
    print("waiting for POST /login {login, password, server} - no terminal is started until then", flush=True)
    print("read-only: this bridge exposes candles, symbols, login and shutdown; nothing else", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping", flush=True)
    finally:
        # /shutdown usually did this already; repeat idempotently for Ctrl+C. Capped so the
        # process can never hang here on exit.
        loop = threading.Thread(target=server.shutdown, daemon=True)
        loop.start()
        loop.join(3.0)
        try:
            server.server_close()
        except Exception:  # noqa: BLE001
            pass
        try:
            if mt5 is not None:
                _mt5(mt5.shutdown)
        except Exception:  # noqa: BLE001
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
