# Verification log

Every claim in the README is backed by one of these runs. Commands are reproducible
on this machine; numbers are copied from real output, not estimated.

## 1. Unit tests — 276 passing, 14 files

```
$ npx vitest run
 ✓ tests/indicators.test.ts      (29)
 ✓ tests/aggregate.test.ts       (18)
 ✓ tests/account.test.ts         (21)
 ✓ tests/pine-runtime.test.ts    (17)
 ✓ tests/feed.test.ts            (20)
 ✓ tests/backtest.test.ts        (18)
 ✓ tests/indicators-ext.test.ts  (22)
 ✓ tests/optimize.test.ts        (23)
 ✓ tests/drawings.test.ts        (26)
 ✓ tests/csv.test.ts             (25)
 ✓ tests/pine-parse.test.ts      (18)
 ✓ tests/timezone.test.ts        (14)
 ✓ tests/symbol.test.ts          (16)
 ✓ tests/series.test.ts          (9)
 Test Files  14 passed (14)
      Tests  276 passed (276)
```

Bugs these tests caught during development (each fixed, each now guarded):

| Bug | Why it mattered |
|---|---|
| DST spring-forward resolved to the wrong side | a bar in the 02:00–03:00 gap landed an hour off |
| NaN in SMA poisoned every later value forever | one bad bar blanked a whole indicator line |
| CSV header detection ate the first bar of a headerless file | silent data loss |
| Yahoo `240m` mapped to `1h` | hourly data labelled as 4-hourly |
| `ta.crossover` keyed its previous values by bar index | it could never fire; crossovers were invisible |
| Unary parsing called `next()` twice | `-x` consumed the following token |
| `switch` comparison arms were parsed as values, not conditions | every arm fell through to the default |
| `axisValues` dropped the upper bound on float steps | optimizer never tested the max value |
| `findSymbol('GC=F')` threw | crashed the strategy panel for any live symbol |
| Strategy could not compile in the renderer (CSP blocks `new Function`) | the tester silently reported 0 trades |

## 2. Typecheck — clean under strict

```
$ npx tsc --noEmit -p tsconfig.json
(no output)
```

`strict` + `noUncheckedIndexedAccess`; no `any` escapes in core.

## 3. Offline proof — PASS

```
$ node scripts/verify-offline.mjs
1. static scan of the built renderer bundle
   scanned 3 files: 0 live, 16 inert (namespaces/licence/error text)
2. CSP and main-process navigation guards
   index.html declares connect-src 'none': true
   index.html declares default-src 'self' : true
   will-navigate blocked: true
   windowOpenHandler denies: true
   nodeIntegration false: true
   contextIsolation true: true
PASS - the app is offline-clean
```

The 16 "inert" hits are XML namespace identifiers, the React error-decoder URL
embedded in a thrown message, and licence URLs — none is dereferenced. The scanner
classifies rather than just grepping, so a real network call could not hide behind
them.

## 4. Headless boot — renders

```
$ bash scripts/headless-smoke.sh
debugger ready after 4s
{"title":"FX Replay Lab","canvases":7,"totalCanvasPixels":1919112,
 "railTabs":["data","indicators","strategy","journal"],"badge":"OFFLINE",
 "hasBrand":true}
```

## 5. Live network path through the real UI

```
$ bash scripts/live-smoke.sh
BEFORE: {"bridge":true,"badge":"OFFLINE"}
LIVE:   {"badge":"LIVE","note":"Live from yahoo","status":"Live from yahoo — 5,821 bars"}
BACKTEST: {"rows":12,"pairs":["trades132","net profit-1170.60","win rate28.0%",
           "profit factor0.77","max drawdown1170.60 (11.7%)","expectancy-8.87"],
           "msg":"132 trades, net -1170.60","errs":[]}
```

This goes through: real renderer → IPC → main process → HTTPS to Yahoo → back
through the same layers → account engine → stats table. 5,821 real 5-minute gold
futures bars.

**The result is negative and is reported as such.** EMA(9/21) crossover on 5-minute
gold loses money: 28% win rate, PF 0.77, −11.7% drawdown over 132 trades. Nothing
was tuned to make it look profitable.

## 6. Pine Script through IPC

```
$ bash scripts/pine-smoke.sh
PINE:     {"msg":"2 series, 9 shapes","errs":[]}
BAD_PINE: {"msg":"20 error(s)","errs":["unsupported ta.notReal() (bar 0)"]}
```

An unsupported function fails with its name and bar number. It does not silently
produce a wrong chart.

## 7. Packaging — artefacts built

```
release/FX Replay Lab-0.1.0-x86_64.AppImage   110 MB
release/FX Replay Lab-0.1.0-amd64.deb          76 MB
```

deb metadata:
```
Package: fx-replay-lab
Version: 0.1.0
Maintainer: FX Replay Lab <noreply@drogon.site>
Depends: libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, ... 
```

## 8. Packaged artefact actually runs

The dev tree working proves nothing about the bundle. This runs the real AppImage:

```
$ bash scripts/packaged-smoke.sh
testing: release/FX Replay Lab-0.1.0-x86_64.AppImage
packaged app booted after 3s
PACKAGED STATE: {"title":"FX Replay Lab","canvases":7,
  "railTabs":["data","indicators","strategy","journal"],"badge":"OFFLINE",
  "legend":"XAUUSD (sample)·M5·O 1990.76 H 1993.19 L 1989.63 C 1991.71",
  "bridgeOk":true,"credit":true,"hasError":false}
SQLITE: {"ok":true,"count":0}
STRATEGY HOST: {"ok":true}
```

`SQLITE: ok` matters: better-sqlite3 is a native addon that must live in
`app.asar.unpacked` with an ABI matching Electron. Listing accounts proves the
module loaded inside the bundle, which a build log cannot.

## 9. Manual trading -> automatic journal capture

The renderer had no trading UI at all before this: the account engine existed and the
backtester drove it, but a user could not place an order. `scripts/trade-smoke.sh`
exercises the whole chain with real clicks:

```
PANEL:   bid 1991.71, balance 10000.00, equity 10000.00, 4 order inputs
OPEN:    "buy 0.1 opened", 1 open position
STEP:    40 bars stepped, balance 9989.70  (stop fired)
JOURNAL: trades1, net P/L -10, win rate 0.0%
         rows: XAUUSD buy -10 -1.03
         by tag: sl 1 -10, auto-test 1 -10
SQLITE:  XAUUSD buy lots=0.1 pnl=-10.30 risk=10.00 tags=['sl','auto-test']
```

Reading that: a buy was placed with a 1-point stop (risk $10 on 0.10 lots of gold),
the replay advanced, the stop was hit, and the journal received the trade
automatically with `sl` as the reason and `auto-test` as the user's tag. The R of
−1.03 is real: $10.30 lost against $10.00 risked, the extra 0.30 being commission.

**A bug this test caught that unit tests could not.** The trade existed in the
session (`"sections":["Trade","Closed (1)"]`) but the journal showed zero rows and
the database had zero rows. The journal drained the session's pending buffer on
mount, then SQLite hydration resolved and *replaced* state with the stored rows,
discarding the drained entry — and since the buffer was already empty, the entry was
destroyed rather than delayed. Hydration now merges into current state. A
load-then-mutate flow must never `set(existing)`; it must `set(prev => merge(...))`.

## 10. CI config validated locally

```
$ node scripts/verify-workflow.mjs
=== workflow ===
  matrix over 3 OS: true      uploads artefacts: true
  runs tests: true            typechecks: true
  offline check: true         rebuilds native: true
=== electron-builder.yml ===
  win nsis target: true  win portable zip: true  mac dmg: true
  linux AppImage: true   asarUnpack better-sqlite3: true
  publish null (offline): true
PASS - CI config is structurally sound
```

## What is NOT verified here

- **Windows and macOS installers were not run.** electron-builder produces them in
  CI, but this machine is Linux only. The nsis/dmg configuration is validated
  structurally, not by execution.
- **5M-bar performance in the real UI** is not measured. Aggregation and backtest
  throughput are exercised in unit tests (and the 5M-bar storage estimate is
  arithmetic, not a benchmark), but the interactive chart at that size has not been
  profiled on a real desktop.
- **Drawing tools on canvas** — the model, hit-testing and undo/redo are unit tested;
  mouse interaction is not wired yet, so there is nothing to verify.
- **SQLite journal persistence** — schema exists, UI writes are in memory only.
