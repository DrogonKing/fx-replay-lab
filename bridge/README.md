# Testing the MT5 bridge (v2)

Three things get tested, in this order. Each one is separate on purpose, because a failure in
step 1 makes steps 2 and 3 pointless, and mixing them hides which one broke.

| Step | Where | What it proves |
|---|---|---|
| 1 | your Windows machine | the bridge's code is healthy (works even with no terminal) |
| 2 | your Windows machine | the HTTP endpoints answer, the login path works |
| 3 | this app | Connect performs the real login and the chart fills |

## How login actually works (measured against a real IC Markets account)

The MetaTrader5 package's own terminal launch is NOT used: measured, its IPC handshake
gives up (`-10005 IPC timeout`) long before a cold terminal finishes booting, while the
terminal it spawned keeps booting and logs in on its own seconds later. So the bridge
launches the terminal itself (`Popen`), hides its windows while it boots (matched by
process name — the main window is titled "<login> - <server>…", NOT "MetaTrader 5"),
and retries `initialize(path, login, password, server)` every 4 s until the terminal is
ready (a fresh boot measures ~13–16 s end to end, hidden throughout).

Two time facts that cost real debugging:

1. Bar and tick times arrive on the broker SERVER's wall clock (a +3 h EEST server in
   the measurement), so every stamp is shifted to true UTC before leaving the bridge.
   The offset is detected from a live TICK (crypto symbols first — 24/7, so weekends
   cannot starve the detection), because a just-booted terminal's chart history is not
   synced yet and stale bars produce plausible-looking wrong offsets. Detection retries
   lazily on /health and /candles until the feeds are up.
2. `copy_rates_range` interprets the request datetimes on the SERVER clock too, so a
   true-UTC window is translated (+offset) before the call and the stamps shifted back
   (−offset) after. Verified against ground truth: the last EURUSD bar of the week
   lands at 20:56 UTC Friday — the New York close — not at 23:56.

---

## Step 0 — what you need

- **Windows.** The `MetaTrader5` Python package ships `win_amd64` wheels only (verified on
  PyPI: cp36 through cp314, all Windows). It cannot run on Linux or macOS.
- **MetaTrader 5 installed.** It does **not** need to be running or logged in anymore — v2
  logs the terminal in itself, from credentials you type in the app, and then hides the
  terminal's windows. Log in by hand once only if you prefer that; the bridge also attaches
  to an already-running terminal when it is on the same account.
- **Python 3.10–3.14** for Windows — or nothing at all: the repo vendors an isolated runtime
  at `bridge/python` (CPython 3.11.9 + MetaTrader5), and the app uses that one.

MT4 note: the official Python package is MT5-only. For MT4 there is no equivalent, so an MT4
account needs an MT5 terminal on the same broker (most brokers provide both).

---

## Step 1 — the self-test

Open PowerShell in the project folder and run:

```powershell
bridge\python\python.exe bridge\mt5-bridge.py --selftest
```

(or `python bridge\mt5-bridge.py --selftest` with your own Python, after `pip install MetaTrader5`)

On a machine with **no MetaTrader running** it looks like this — and this is a PASS:

```
  [PASS] Windows                                    yes
  [PASS] Python 3.11                                cp311
  [PASS] MetaTrader5 package                        imported
  [PASS] window-hider sweep is exception-free       0 MetaTrader window(s) processed
  [PASS] mt5 calls hold the global lock             acquire(blocking=False) failed inside the call, as it must
  [PASS] server-timezone shift math is exact        5 synthetic cases exact
  [SKIP] terminal running and logged in             not available ((-6, 'Terminal: Authorization failed')) — data checks need a running terminal; this is not a failure

ALL CHECKS PASSED (7 checked, terminal checks SKIPPED: no running
terminal on this machine).
```

**SKIP is not FAIL.** The first six checks are code checks — the lock that makes the bridge
thread-safe, the window hider, the timezone math — and they must always say PASS. The
terminal checks need a running, logged-in terminal; when there is none they say SKIP so the
diagnostic stays green on a healthy dev box. A diagnostic that fails on a healthy machine
gets ignored, which is how real failures get ignored too.

With a terminal running and logged in, the skipped checks turn into PASS (symbols, EURUSD M1
bars, price plausibility, live timezone detection) — that is the only version of the suite
that exercises the broker data path.

| FAIL on | Meaning | Fix |
|---|---|---|
| Windows | you are not on Windows | run it on Windows, or a Windows VM |
| MetaTrader5 package | not installed | use `bridge\python\python.exe`, or `pip install MetaTrader5` |
| window-hider sweep | a Windows API call went wrong | send the output with your bug report |
| mt5 calls hold the lock | a code regression | send the output |
| timezone shift math | a code regression | send the output |

---

## Step 2 — the endpoints

Start the bridge:

```powershell
bridge\python\python.exe bridge\mt5-bridge.py
```

It prints immediately — v2 binds the HTTP server **before** touching any terminal, so a
missing or logged-out terminal can no longer kill the bridge at startup:

```
bridge listening on http://127.0.0.1:8765
waiting for POST /login {login, password, server} - no terminal is started until then
read-only: this bridge exposes candles, symbols, login and shutdown; nothing else
```

Then, **in a second PowerShell window**:

```powershell
# 1. is it alive? connected:false is correct here — nothing is logged in yet
curl http://127.0.0.1:8765/health
# -> {"ok": true, "connected": false, "account": null, ... , "serverOffsetSeconds": null}

# 2. the real login (use your DEMO account's values)
curl -X POST http://127.0.0.1:8765/login -d "{\"login\": 12345678, \"password\": \"...\", \"server\": \"ICMarkets-Demo\"}"
# -> {"ok": true, "account": "#12345678", "server": "ICMarkets-Demo", "company": "...",
#     "symbols": 1639, "terminalPid": 4212, "startedByUs": true, "hidden": true}

# 3. candles, now in TRUE UTC (v1 returned broker-server time)
curl "http://127.0.0.1:8765/candles?symbol=EURUSD&timeframe=M1&from=1704153600&to=1704239999"
```

The login is the real test. Three things happen on it, in order:

1. the terminal is located (Program Files, `%LOCALAPPDATA%\Programs`, the registry App Paths
   key, the MetaQuotes common.ini);
2. `mt5.initialize(path, login, password, server)` performs the **real credential login** —
   this is the fix for v1, which accepted credentials and silently ignored them;
3. the terminal's windows are **hidden** (title/class match, `ShowWindow(SW_HIDE)`), and a
   watcher re-hides late-appearing windows every 500 ms for 30 s — the terminal creates
   chart windows seconds after launch. So: a window may flash briefly, then vanish. That is
   expected. The watcher stops after 30 s, so if you deliberately open MetaTrader later, it
   stays open.

`/health` now reports `serverOffsetSeconds` — the detected difference between the broker's
server clock and UTC (typically +7200/+10800 for GMT+2/+3). If detection fails (market
closed, stale bars) it reports `null` plus a `note`, and candle times are **not** shifted.
That is deliberate: an unshifted chart is diagnosable; a chart silently shifted by a wrong
offset is not.

**Failed login?** The error names the actual cause: wrong password/server gives MetaTrader's
own `last_error()`, a running terminal on a *different* account says which account it is on,
and a missing installation lists the places that were searched. The password itself is
scrubbed from every reply and never logged or written to disk.

The broker-suffix trap from v1 still applies — if candles say `symbol 'EURUSD' not available
at this broker`, check `/symbols` for the exact name your broker uses (`EURUSD.m`,
`EURUSD#`, …). It is still the single most common "doesn't work".

---

## Step 3 — the app

Press **Connect** and enter the demo credentials there. That button now performs the real
login described above: it starts the terminal, logs in, hides the window, and the chart
fills with that account's candles. `/shutdown` is called automatically when the app quits,
so neither the python bridge nor a terminal it started leaks into your process list.

If you do not have broker credentials, the app's offline/downloaded-data mode works without
any of this.

---

## The automated suite

`bridge\test-bridge-http.py` exercises the whole HTTP layer against a stub MetaTrader5
module — including a regression test that the credentials actually reach
`mt5.initialize()`, the UTC shift, the 405 read-only policy, and a scan that the password
never appears in any response:

```powershell
bridge\python\python.exe bridge\test-bridge-http.py   # 21/21 passed
```

It runs green on machines with no MetaTrader at all. One caveat: on a machine that has a
real MetaTrader window open while the suite runs, the window hider will hide it — that is
its contract; restart the terminal afterwards.

---

## When reporting a problem

Send the output of `--selftest`, the `/health` body, and the exact login reply. Those three
say which layer failed; without them the answer is a guess.

Do not send your password. Nothing here needs it — if you must test by hand, change the
demo password afterwards.
