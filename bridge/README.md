# Testing the MT5 bridge

Three things get tested, in this order. Each one is separate on purpose, because a failure in
step 1 makes steps 2 and 3 pointless, and mixing them hides which one broke.

| Step | Where | What it proves |
|---|---|---|
| 1 | your Windows machine | the bridge can see your broker's data |
| 2 | your Windows machine | the HTTP endpoints answer correctly |
| 3 | this app | it can use what the bridge returns |

---

## Step 0 — what you need

- **Windows.** The `MetaTrader5` Python package ships `win_amd64` wheels only (verified on
  PyPI: cp36 through cp314, all Windows). It cannot run on Linux or macOS.
- **MetaTrader 5 installed and logged in** to your demo account. Log in by hand — that way the
  bridge never needs your password at all.
- **Python 3.10–3.14** for Windows, from python.org.

MT4 note: the official Python package is MT5-only. For MT4 there is no equivalent, so an MT4
account needs an MT5 terminal on the same broker (most brokers provide both).

---

## Step 1 — the self-test

Open PowerShell in the project folder and run:

```powershell
pip install MetaTrader5
python bridge\mt5-bridge.py --selftest
```

It checks, in order:

```
  [PASS] Windows                                    yes
  [PASS] Python 3.11                                cp311
  [PASS] MetaTrader5 package                        imported
  [PASS] terminal already running and logged in     ICMarkets-Demo #12345678
  [PASS] symbols visible                            1639 symbols
  [PASS] EURUSD M1 bars (2024-01-02)                1440 bars
  [PASS] bar prices plausible                       first open 1.10432
```

**Every line must say PASS.** The order matters: the first FAIL is the real problem.

| FAIL on | Meaning | Fix |
|---|---|---|
| Windows | you are not on Windows | run it on Windows, or a Windows VM |
| MetaTrader5 package | not installed | `pip install MetaTrader5` |
| terminal...logged in | MetaTrader is closed or not logged in | open it and log in |
| symbols visible | terminal has no account attached | log in again in the terminal |
| EURUSD M1 bars | broker does not serve that symbol, or history is not downloaded | right-click the chart → *Refresh*, or test another symbol |
| bar prices plausible | the feed is returning 0 or a nonsense price | check the account is really a *demo* on a live server |

**A pass here does not depend on any of my code being right about your broker** — it is the
broker's own data through the broker's own terminal.

---

## Step 2 — the endpoints

Start the bridge:

```powershell
python bridge\mt5-bridge.py
```

It prints:

```
connected: ICMarkets-Demo #12345678 (demo)
bridge listening on http://127.0.0.1:8765
read-only: this bridge exposes candles and symbols, nothing else
```

Then, **in a second PowerShell window**:

```powershell
# 1. is it alive?
curl http://127.0.0.1:8765/health

# expected: {"ok":true,"connected":true,"symbols":1639}

# 2. does your broker name EURUSD exactly that way?
curl "http://127.0.0.1:8765/candles?symbol=EURUSD&timeframe=M1&from=1704153600&to=1704239999"
```

The second one is the real test. Expected: a long JSON with `candles` and 1440 bars.

**If it returns `{"candles":[],"error":"symbol 'EURUSD' not available at this broker"}`** then
your broker uses a suffix. Most do:

| Broker style | Example |
|---|---|
| no suffix | `EURUSD` |
| `.` | `EURUSD.` |
| `#` | `EURUSD#` |
| `_` | `EURUSD_` |
| micro/raw | `EURUSD.m`, `EURUSD.r` |

Find yours: in MetaTrader, right-click the symbol in Market Watch → it shows the exact name. Or:

```powershell
curl http://127.0.0.1:8765/symbols
```

and search the list for `EUR`. This is the single most common reason a bridge "does not work" —
the error message names the exact symbol that was rejected, so it is diagnosable.

---

## Step 3 — the app

**Not built yet, and I am not going to pretend otherwise.** The adapters and the OANDA URL
builder exist and are unit-tested, but there is no broker panel in the app yet, so there is no
button to press.

What you can test today, without the bridge:

1. Open the app → **Replay** → go.
2. The **دانلود** tab → symbol `GBPUSD`, from `January 2010` to `December 2016`.
3. Press **Download**. It runs for hours; close the app and reopen it and it resumes.
4. Press **Choose file…** and pick any CSV/`.bi5`/ZIP you already have.

That is the part that works end to end and is verified.

---

## When reporting a problem

Send the output of `--selftest` **and** the exact `curl` result. Those two lines say which of
the three layers failed, and without them the answer is a guess.

Do not send your password. Nothing here needs it — if the terminal is logged in, the bridge
never asks.
