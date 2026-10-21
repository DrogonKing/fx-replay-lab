# The broker panel

## What it is

A tab that pulls candles from a broker without touching the account. Three transports behind one
list, because "broker" is not one protocol:

| Adapter | Transport | Needs | Windows only |
|---|---|---|---|
| MetaTrader 4/5 (any broker) | local bridge | the terminal, plus `bridge/mt5-bridge.py` | **yes** |
| OANDA v20 | REST | an API token + account ID | no |
| cTrader | open API | OAuth (not implemented) | no |

## The read-only boundary is enforced, not promised

The request was: pull candles from a demo account and never read the balance. That is enforced in
three places:

1. **The bridge exposes four GET routes** — `/health`, `/symbols`, `/timeframes`, `/candles`.
   `POST` returns **405** with `the bridge is read-only`.
2. **The bridge never calls** `account_info()` fields beyond server/login for the startup log. No
   balance, no equity, no positions, no order history.
3. **Main refuses any non-loopback bridge URL.** `bridgeUrlAllowed` accepts `http://` on
   `127.0.0.1` or `localhost` only, and only those four paths. A hostile URL cannot get out.

Verified live: `http://evil.example.com:8765/health` → `that URL is not a local bridge address`.
A lookalike such as `http://127.0.0.1@evil.com/health` (which really connects to evil.com) is
refused too.

## The symbol suffix is the real failure mode

Most brokers do not name the pair `EURUSD`. They use `EURUSD.m`, `EURUSD#`, `EURUSD_`,
`EURUSD.r`. Getting this wrong is the single most common reason a bridge "does not work".

So the panel does not hardcode a symbol:

- after probing, it reads `/symbols` and picks from **what the broker actually lists**
- a `<datalist>` offers the filtered names as you type
- the bridge's error names the rejected symbol verbatim, so it is diagnosable

Verified against a fake bridge that deliberately offers **no plain `EURUSD`**: the panel picked
`EURUSD.m` on its own. A deliberately wrong symbol (`NOPEUSD`) produced
`symbol 'NOPEUSD' not available at this broker` **and left the chart intact** — a failed load must
not wipe the chart.

## Probing proves more than "the port is open"

A `/health` check alone is not enough: a bridge attached to a terminal with no symbols answers
`connected: true` and then fails every candle request. So the probe does three things and reports
which one failed:

1. reachable? → `could not reach … is the bridge running? (python bridge/mt5-bridge.py)`
2. terminal attached? → `the bridge is running but no terminal is attached — open MetaTrader, log in`
3. can it serve a bar? → one real M1 request, 30 days back

Verified live: a dead bridge produced the first message (with the fix in the text, not just a
failure), and a live one reported `connected — 5 symbols · 500 bars · 1.10432`.

## Credentials

- Held in React state, never in the database.
- The OANDA token is used once in main and **scrubbed from every error string** before it leaves
  the function. Verified: a bad token produced a 401 message and `leakedToken: false`.
- The MT5 path needs no password at all if you log in to the terminal by hand, which the guide
  recommends.

## A React trap this surfaced

The first version of the smoke test set `input.value = x` directly. React's controlled inputs
ignore that: the change handler fires but React restores the state value on the next render, so
the URL stayed at its default and every probe failed — looking like eight broken features. The
test now uses the native property setter so React sees a real change. **Any future test that
drives a controlled input must do the same.**

## Still not verified

- **The bridge has never run against a real MetaTrader terminal.** No Windows host here and the
  `MetaTrader5` wheel is `win_amd64` only. The HTTP layer is tested against a stub; the
  `copy_rates_range` call path is not.
- **No OANDA token to test with.** The URL builder, the instrument mapping and the response
  parser are unit-tested (34 tests), and a real 401 is handled correctly — but no successful
  request has been made, so the response *shape* is from their documented schema, not observed.
- **cTrader is not implemented.** Selecting it says so.
- **No streaming and no orders.** Every path pulls bars on request; fills are still simulated.

## Test commands

```bash
bash scripts/broker-smoke.sh        # 8 live scenarios against scripts/fake-bridge.py
python3 bridge/test-bridge-http.py  # 11 HTTP-layer checks against a stub MetaTrader5
npx vitest run tests/brokers.test.ts tests/broker-boundary.test.ts
```
