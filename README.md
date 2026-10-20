# FX Replay Lab

A fully offline desktop app for replay trading and strategy backtesting on FX,
gold, indices and crypto — with a TradingView-like chart. Turns live when a network
is available; works completely without one.

Electron 32 · React 18 · TypeScript (strict) · Vite · Lightweight Charts
(Apache-2.0, bundled locally, no CDN).

## Two modes, one code path

| | Online | Offline |
|---|---|---|
| Chart data | fetched from Yahoo Finance | imported CSV or cached history |
| Replay | ✅ | ✅ |
| Backtest / optimizer / Monte Carlo | ✅ | ✅ |
| Network calls | through the main process only | **none** — CSP is `connect-src 'none'` |

The renderer never opens a socket. Live data goes through IPC to the main process,
which only reaches an allow-list of HTTPS hosts. Offline mode simply never calls it,
so "no network" is structural rather than a flag someone can forget.

## Verified state

```
649 unit tests, 27 files ..................... pass
strict typecheck (noUncheckedIndexedAccess) ... clean
offline verification ......................... PASS
CI config validation ......................... PASS
headless boot + DOM assertions ............... pass
real Yahoo fetch through the UI .............. 5,821 bars, badge LIVE
real backtest through the UI ................. 132 trades, net -1,170.60
Pine script through the UI ................... 2 series, 9 shapes
```

Those backtest numbers are a **negative result for a plain EMA(9/21) crossover on
5-minute gold** and are reported as such — 28% win rate, profit factor 0.77 over
132 trades. The engine is not tuned to look good.

## What is built

- **Core** (pure TS, no Electron/DOM): columnar candle store (~240 MB for 5M bars),
  IANA timezone math with DST, timeframe aggregation (any minute count; D/W anchored
  to a configurable session open), account engine shared by manual trading, replay
  and backtesting, CSV import with layout/delimiter/header auto-detection.
- **Indicators**: SMA, EMA, WMA, RMA, RSI, ATR, MACD, Stochastic, Bollinger, VWAP,
  ADX (+DI/−DI), CCI, Ichimoku, Parabolic SAR, Supertrend, Volume, floor-trader
  pivots (classic + Fibonacci).
- **Strategy tester**: JavaScript API, next-bar fill (no look-ahead), full statistics
  (net, PF, DD, Sharpe, Sortino, expectancy, streaks, MAE/MFE, monthly), grid/random
  optimizer with a hard cap, walk-forward with non-overlapping windows, Monte Carlo
  with percentile bands.
- **Pine Script**: lexer, indentation-aware parser, evaluator for a documented subset
  (`var`, `[]` history, if/for/while/switch, user functions, ~25 `ta.*`, `math.*`,
  `str.*`, plotting, strategy orders). See `docs/PINE-COMPATIBILITY.md`.
- **Chart**: candlesticks, 8 indicators, replay transport, timezone and custom
  timeframes, symbol legend with OHLC.
- **Drawing toolkit**: 60+ tools in 9 grouped flyouts — lines, channels (incl.
  pitchfork), shapes, Fibonacci (retracement/extension/channel/time-zone/fan/arcs/
  wedge), Gann fan and box, chart patterns with ratio validation (XABCD, ABCD,
  Elliott, head & shoulders, harmonics), forecast and position tools with R multiple
  and money-at-risk, 10 annotation types, measure. Canvas overlay, undo/redo, drag to
  move, verified by real pointer events. See `docs/DRAWING-TOOLS.md`.
- **Manual trading**: order form with lot/SL/TP/tags, risk-and-reward preview in money,
  margin check, open-positions table with per-row close, live equity and floating P/L,
  stop-out halt. Runs on the same `AccountEngine` as the backtester, so a strategy that
  shows a profit and a hand-placed trade are priced identically.
- **Order types**: market, limit, stop and stop-limit, plus OCO brackets. Gaps are
  honoured in both directions (a stop gaps *worse*, a limit gaps *better*), an order
  that would fill instantly is refused rather than silently converted, and a stop-limit
  arms at its trigger price. See `docs/ORDER-TYPES.md`.
- **Position management**: entry/SL/TP drawn as dashed level lines with price tags, SL
  and TP draggable on the chart. A drag that would put a stop on the wrong side of the
  entry is refused with the reason shown — that shape is a guaranteed instant loss.
  Auto break-even moves the stop to the entry (plus commission) once a position reaches
  a configurable R multiple, and only ever tightens. See
  `docs/POSITION-MANAGEMENT.md`.
- **Trailing stop and partial close**: trail behind the close, the bar's high/low, or
  `N × ATR(14)`. A trail derived from one bar only protects the **next** — applying it to
  the bar that created it closes winning trades for a loss, which is why the engine
  orders it after the SL/TP pass. The `½` button closes part of a position, produces its
  own journal entry, splits commission proportionally, and refuses a remainder that is
  off the lot step rather than rounding. See `docs/TRAILING.md`.
- **Economic calendar**: import a provider CSV (date+time split or combined, day-first
  auto-detection, impact as words/stars/numbers), stored in SQLite, drawn as impact-coloured
  chart markers. A high-impact window **refuses new orders in the engine** — measured
  against the replay clock, not wall time — while closing a position stays allowed. Skipped
  rows are reported with line numbers instead of being dropped silently. See
  `docs/NEWS-CALENDAR.md`.
- **English and Persian (RTL)**: switch in the toolbar, remembered across restarts. `dir`
  on `<html>` is the only direction mechanism — grid and flex mirror themselves, and
  explicit `[dir]` layout overrides actively *cancel* that mirror (measured: panel back at
  offsetLeft 1160, i.e. LTR). Numbers stay Latin and LTR in both languages, because
  `۱۹۹۱.۷۱` cannot be pasted into a broker statement. See `docs/I18N.md`.
- **Journal**: entries with tags, R multiples, per-tag and per-month analytics, CSV
  export, row delete. **Closed trades are filed automatically** and tagged with the exit
  reason (`sl`, `tp`, `manual`, `stop-out`); money-at-risk is captured at entry so the R
  multiple is real and not back-derived from a trailed stop.
- **Persistence**: drawings and journal are stored in SQLite and restored on launch.
  Drawings are keyed by `symbol::timeframe`, autosaved on a debounce, and validated at
  a single boundary — proven by drawing, inspecting the file, `kill -9`, relaunching
  and asserting the shapes paint again (`scripts/persist-smoke.sh`).
- **Packaging**: electron-builder for Windows (nsis + portable zip), macOS (dmg),
  Linux (AppImage + deb). GitHub Actions runs verify → package matrix → release.

## Not built

Stated plainly, because a checklist that hides gaps is worse than no checklist:

- Swap accrual (computed per trade but no daily rollover) and margin-call **threshold**
  (stop-out at zero equity works; a broker-style margin call warning does not).
- **No partial fills** and no order expiry (day/GTC); an order lives until it fills or
  is cancelled.
- News calendar, session shading.
- Pine: no `request.security`, no `label`/`line`/`box`, no tuple destructuring, no
  `import`.
- i18n (Persian RTL) not started.
- Windows/macOS installers are produced by CI but were **not** run on this machine.

Full per-item status: `docs/CHECKLIST.md`.

## Develop

```bash
npm install
npx electron-rebuild -f -w better-sqlite3   # required: native ABI must match Electron
npm test
npm run build
npm start
```

Verification scripts:

```bash
node scripts/verify-offline.mjs    # prove the bundle is offline-clean
node scripts/verify-workflow.mjs   # validate CI + packaging config
bash scripts/headless-smoke.sh     # boot under Xvfb and assert the DOM
bash scripts/live-smoke.sh         # real network + real backtest via the UI
bash scripts/pine-smoke.sh         # Pine through IPC
bash scripts/draw-smoke.sh         # real pointer events paint; undo repaints
bash scripts/persist-smoke.sh      # drawings survive kill -9 + relaunch
bash scripts/journal-smoke.sh      # journal survives kill -9 + relaunch
bash scripts/trade-smoke.sh        # trade -> SL fires -> journal entry, end to end
bash scripts/orders-smoke.sh       # limit fills, invalid side refused, OCO pair
bash scripts/position-smoke.sh     # level lines, real SL drag, break-even
bash scripts/trailing-smoke.sh     # trail tightens, never closes early, partial close
bash scripts/news-smoke.sh         # calendar import, persist, blackout refuses an order
bash scripts/i18n-smoke.sh         # Persian switch, RTL mirror, Latin digits, reload
```

## Docs

- `PLAN.md` — milestones and risks
- `DECISIONS.md` — architecture decisions with reasoning
- `docs/CHECKLIST.md` — every requirement, honestly marked
- `docs/USER_GUIDE.md` — how to use it, incl. known limitations
- `docs/PINE-COMPATIBILITY.md` — exact Pine subset + trust boundary

## Licence

Charting by [Lightweight Charts](https://www.tradingview.com/lightweight-charts/)
(Apache-2.0), bundled locally. No TradingView logos or proprietary assets are used
(`attributionLogo: false`).

An independent implementation. Not affiliated with TradingView, Soft4FX or MetaQuotes.
