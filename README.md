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

## Verified state (v2, on Windows)

```
1345 unit tests, 55 files .................... pass
strict typecheck (noUncheckedIndexedAccess) ... clean
build (renderer + main) ...................... pass
boot smoke: window opens, no errors .......... pass
bridge HTTP suite (stubbed MetaTrader5) ...... 21/21 pass
bridge selftest (real package, no terminal) .. pass (terminal checks SKIP)
```

The v1 Linux smoke suite (bash/Xvfb) was removed with the v2 prune — this repo
now lives on Windows, where the MetaTrader integration actually runs. A
Windows-capable e2e harness is future work; today the app is verified by the
suite above plus manual runs.

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
- **Trading sessions**: shade Sydney / Tokyo / London / New York on the chart, defined in
  each city's **local** clock so the bands follow daylight saving (London opens 08:00 UTC in
  January, 07:00 UTC in July). The journal is broken down by the session a trade was opened
  in, with the London/New York overlap counted once so the buckets sum to the total. See
  `docs/SESSIONS.md`.
- **Live sessions survive the app closing**: balance, open positions, pending orders (OCO
  groups included), closed trades and the replay cursor are written as they change, and a
  SIGKILL is the test — not a graceful quit that could hide a missing save behind an exit
  handler. A corrupt session is refused with a reason rather than partly applied. See
  `docs/LIVE-SESSION.md`.
- **Risk-based sizing**: enter a percentage and a stop distance, and the lot size is computed
  from the budget — always rounded **down**, because rounding up risks more than asked. When
  even the minimum lot would over-risk, the trade is refused with the arithmetic and the
  Buy/Sell buttons are disabled. See `docs/RISK-SIZING.md`.
- **Whole-book risk**: the total at stake across open positions *and* pending orders, because
  three 1% positions are each safe and together put 3% at risk. Positions with no stop are
  reported as a count — their risk is unknown, not zero. The limit itself is **off by default**;
  the readout is always live, only the refusal is opt-in. See `docs/BOOK-RISK.md`.
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
npm test                                    # runs under the Node ABI (before rebuild)
npm run build
npm start
```

Order matters on a fresh clone: `npm test` first (Node ABI), then
`electron-rebuild`, then `npm start` (Electron ABI) — better-sqlite3 has one
binary and it cannot satisfy both at once.

Verification scripts that remain:

```bash
node scripts/verify-offline.mjs            # prove the bundle is offline-clean
node scripts/verify-workflow.mjs           # validate CI + packaging config
bridge\python\python.exe bridge\test-bridge-http.py   # bridge v2 HTTP suite (stubbed MT5)
bridge\python\python.exe bridge\mt5-bridge.py --selftest
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
