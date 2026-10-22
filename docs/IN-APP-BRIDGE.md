# In-app MetaTrader bridge

## The requirement

> "Make that bridge happen inside the app itself: I just give username, password and server, and it
> connects."

So the app owns the whole chain. No terminal, no `pip install`, no second window, no manual step.

## What ships

`bridge/python/` holds a complete CPython 3.11 runtime plus the two packages the bridge imports:

```
python.exe                 embeddable CPython 3.11.9
python311.zip              stdlib
Lib/site-packages/
  MetaTrader5/             _core.cp311-win_amd64.pyd   (native)
  numpy/                   required by MetaTrader5
python311._pth             wires sys.path to Lib/site-packages
```

64MB. It is **not committed** — `scripts/fetch-python-runtime.mjs` downloads pinned versions and
verifies the tree, and CI runs it before packaging. A committed binary blob would bloat every clone
and still not be reproducible.

## The chain

```
[Connect pressed]
      |
      v
main: startBridge()          spawn bridge/python/python.exe bridge/mt5-bridge.py --port 8765
      |                      wait for /health to answer, not merely for the process to exist
      v
main: bridgeLogin()          POST /login {login, password, server}
      |
      v
bridge: mt5.initialize(...)  the real MT5 terminal on this machine
```

The password crosses the IPC boundary, is used once, is scrubbed from every error string, and is
cleared from the field on success. It is never written to disk and never logged.

## Platform reality

`MetaTrader5` publishes **win_amd64 wheels only**. There is no macOS or Linux build, by the vendor,
not by omission. So:

- On **Windows**: the whole flow works, and the app reports which stage failed if it does not.
- Elsewhere: the panel says so in words, disables Connect, and does not pretend. Charting, replay,
  backtesting and CSV import are unaffected.

Verified on Linux — the honest outcome is that it refuses:

```
bridgeAvailability → {available: false, platform: "linux",
                      reason: "MetaTrader's Python package ships Windows-only binaries…"}
panel              → reason shown, Connect disabled, no contradictory probe message
```

And the HTTP + IPC layers, which are platform-independent, verified green against a stub bridge:

```
testBridge    → ok, 5 symbols, 500 bars
bridgeLogin   → ok, "Stub #10000001 (demo)"
```

## What this does NOT prove

`mt5.initialize(login=…, password=…, server=…)` against a real ICMarkets demo account has **never
been executed** — not by me, not by CI, not by any test in this repo. The interpreter cannot even
start here (win_amd64 on a Linux host). Everything up to the MT5 call is proven; the MT5 call itself
is unproven until someone runs it on Windows with a terminal installed.

If it fails there, the bridge returns MetaTrader's own error text and the panel shows it verbatim,
along with the stage that failed — which is the point of the step list.

## Why the manual instructions were deleted

The old panel told the user to install Python, `pip install MetaTrader5`, and run a script. That is
now false: the app does all of it. Stale help text is worse than none, because it sends people to do
work that is no longer needed and makes them doubt the button when it does not apply.
