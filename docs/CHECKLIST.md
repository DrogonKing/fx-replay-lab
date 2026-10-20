# Manual and automated test checklist

Honest state of every requirement. `[x]` verified by a test or script in this
repo; `[~]` implemented but not verified end-to-end; `[ ]` not implemented.

## Automated (all passing)

```bash
npm test                              # 276 unit tests, 14 files
npx tsc --noEmit -p tsconfig.json     # strict typecheck, clean
npm run build                         # renderer 346 KB + main
node scripts/verify-offline.mjs       # PASS - offline-clean
node scripts/verify-workflow.mjs      # PASS - CI structurally sound
bash scripts/headless-smoke.sh        # boots, renders, DOM asserted
bash scripts/live-smoke.sh            # real Yahoo fetch + real backtest via UI
bash scripts/pine-smoke.sh            # Pine parse+evaluate through IPC
bash scripts/draw-smoke.sh            # real pointer events paint, undo repaints
bash scripts/persist-smoke.sh         # drawings survive kill -9 + relaunch
bash scripts/journal-smoke.sh         # journal survives kill -9 + relaunch
bash scripts/trade-smoke.sh           # trade -> SL -> journal entry, end to end
bash scripts/orders-smoke.sh          # limit fills, invalid side refused, OCO pair
bash scripts/screenshot.sh /tmp/a.png # capture the UI
```

Latest real run of the live path:

```
BEFORE: bridge=true, badge=OFFLINE, tabs=[data, indicators, strategy, journal]
LIVE:   badge=LIVE, "Live from yahoo — 5,821 bars"
BACKTEST: 132 trades, net -1170.60, win 28.0%, PF 0.77, DD 1170.60 (11.7%)
PINE:   2 series, 9 shapes
BAD PINE: "unsupported ta.notReal() (bar 0)"  ← precise, not silent
```

## Phase 1 — Foundation
- [x] Electron 32 + React 18 + TS strict + Vite
- [x] `src/core` free of Electron/DOM (runs under node in tests)
- [x] Columnar storage (ADR-001), 5M bars ≈ 240 MB
- [x] UTC epoch seconds everywhere (ADR-003)
- [x] SQLite schema: accounts, trades, news, settings, workspaces
- [x] test / typecheck / build / dist scripts
- [x] offline verification: bundle scan + CSP + main-process guards
- [ ] eslint config (script exists, config not written)
- [ ] worker threads (declared in plan, not used yet)

## Phase 2 — Data and chart
- [x] CSV delimiter auto-detection (comma, semicolon, tab)
- [x] Layout A: `date,time,O,H,L,C[,vol]` with `.`/`-`/`/` dates
- [x] Layout B: `timestamp,O,H,L,C` with epoch s / epoch ms / ISO
- [x] UTC offset applied to imported times
- [x] Base timeframe detected from median spacing
- [x] Invalid OHLC rejected, not coerced, with a count
- [x] Newest-first sorted ascending
- [x] TF M1…W1 + arbitrary minute counts; below-base refused
- [x] Timezone selector relabels only
- [x] Day/week anchored to configurable session open, DST-correct
- [x] Live forming higher-timeframe bar
- [x] Candlestick chart with zoom/pan/crosshair
- [x] 30k-bar sample on first start
- [x] No TradingView logo; attribution present
- [x] Symbol legend with OHLC
- [x] Drawing model: 60+ tools across lines, channels, shapes, Fibonacci, Gann,
      patterns (XABCD/ABCD/Elliott/head-shoulders/harmonics), forecast, annotation,
      measure
- [x] Interaction state machine: drag-create, multi-click patterns, drag-to-move,
      hit-testing, cancel, delete
- [x] Canvas overlay rendering with devicePixelRatio handling and frame coalescing
- [x] Tool rail with 9 grouped flyouts, undo/redo/delete, Esc to cancel
- [x] Verified by real pointer events in the running app: trend line, Fib (7 levels),
      rectangle all paint; undo repaints correctly
- [x] Drawing persistence per `symbol::timeframe` workspace in SQLite, autosaved
      (600 ms debounce), restored on launch — proven across a `kill -9` restart
- [x] Corrupt rows dropped and counted, never fatal
- [ ] Import dialog with column mapping UI (auto-detect only today)
- [ ] Data quality report UI
- [ ] Symbol manager UI
- [ ] Chart types other than candles; log scale
- [ ] Multi-chart layouts

## Phase 3 — Replay and trading
- [x] Play/pause, step, speeds 1/3/10/40, jump slider
- [x] Info line: bars, base TF, current time in selected TZ
- [x] Buy at ask / sell at bid; commission on entry
- [x] SL/TP per bar on high/low; SL wins inside one bar
- [x] Gap-through fills at the open
- [x] Trailing stop, partial close, hedging vs netting
- [x] Stop-out at zero equity, trading halted
- [x] Floating P/L, equity, used margin
- [x] Hotkeys Space / → / Ctrl+Z
- [x] Order types: limit, stop, stop-limit, OCO brackets — with gap handling,
      side validation, per-order cancel and cancel-all
- [x] Stop-limit arms at the trigger price (not the bar open), stays armed on a gap
- [ ] Break-even automation (move SL to entry at +1R)
- [ ] Swap accrual, slippage, margin call threshold
- [x] Positions table UI with per-row close and close-all
- [x] Margin check: an order that cannot be funded is refused with the numbers
- [x] Trading halts on stop-out and the panel says so
- [x] Closed trades filed to the journal automatically, tagged with the exit reason
- [ ] SL/TP drag on chart
- [ ] Equity curve UI
- [ ] Risk calculator UI

## Phase 4 — Indicators
- [x] Engine: pure, NaN-safe, O(1) per bar
- [x] SMA, EMA, WMA, RMA, RSI, ATR, MACD, Stochastic, Bollinger
- [x] VWAP (session-reset), ADX/+DI/-DI, CCI, Ichimoku, Parabolic SAR, Supertrend, Volume
- [x] Floor-trader pivots (classic + Fibonacci)
- [x] crossover/crossunder/highest/lowest
- [x] 8 indicators selectable in the UI
- [ ] Remaining UI wiring for ADX/CCI/VWAP/Supertrend panes
- [ ] Per-indicator settings dialog, templates, per-TF visibility

## Phase 5 — Strategy tester
- [x] JS API exactly as specified
- [x] Indicator caching per run
- [x] Next-bar fill, no look-ahead (tested)
- [x] Compile/runtime errors reported readably, capped at 20
- [x] Full stats: count, win rate, net, PF, DD money+%, avg win/loss, expectancy, streaks, gross, Sharpe, Sortino, monthly, MAE/MFE
- [x] Equity curve produced
- [x] Optimizer: grid + random, cap, cancel, 6 ranking metrics
- [x] Walk-forward with non-overlapping test windows
- [x] Monte Carlo with percentile bands and P(loss)
- [x] All of it runs in the main process (CSP-safe)
- [ ] Results heatmap, apply-best-parameters
- [ ] Open a backtest trade in replay

## Phase 6 — News and sessions
- [ ] News CSV/JSON import, calendar UI, markers revealed by replay time
- [ ] Avoid-news rule
- [ ] Session shading (Asia/London/NY)

## Phase 7 — Pine Script
- [x] Lexer, indentation-aware parser, AST
- [x] Evaluator: var/varip, `[]` history, if/for/while/switch (incl. comparison arms), user functions
- [x] ta.sma/ema/rma/wma/rsi/atr/macd/stoch/bb/crossover/crossunder/highest/lowest/change/pivots
- [x] math.* and str.* subsets
- [x] plot / plotshape / plotchar / hline / bgcolor
- [x] strategy.entry/exit/close/close_all/order/position_size
- [x] input.* declared and surfaced to the UI
- [x] Precise errors with bar numbers; runaway loop caps
- [x] Value-for-value parity with the core indicators (tested)
- [x] `docs/PINE-COMPATIBILITY.md` complete table
- [x] Runs in the UI through IPC
- [ ] Tuple destructuring `[a,b] = ta.bb(...)`
- [ ] request.security (deliberately absent — look-ahead risk)
- [ ] label/line/box/table
- [ ] import/export libraries

## Phase 8 — Journal
- [x] Entry model with tags, notes, risk
- [x] Analytics: count, net, win rate, expectancy, avg/best/worst R, by tag, by month
- [x] CSV export
- [x] UI panel
- [x] Persistence to SQLite, autosaved, restored on launch — proven across a restart
- [x] Row-level delete and "clear samples"
- [x] Sample rows are explicitly tagged `demo` and the UI warns they are in the stats
- [ ] R-multiple calendar heatmap, PDF export
- [x] Automatic capture of closed trades from the account engine (reason-tagged,
      with money-at-risk captured at entry so R is real)
- [ ] R-multiple calendar heatmap

## Phase 9 — Polish and release
- [x] Offline verification (static + CSP + main guards)
- [x] Headless boot + DOM render assertion
- [x] Real-network live smoke test
- [x] Screenshot capture via CDP
- [x] electron-builder: Windows nsis+zip, macOS dmg, Linux AppImage+deb
- [x] Application icon generated programmatically (512px PNG + multi-size ICO)
- [x] GitHub Actions: verify → package matrix → release on tag
- [x] `docs/USER_GUIDE.md` with known limitations
- [x] `docs/PINE-COMPATIBILITY.md`
- [x] `PLAN.md`, `DECISIONS.md`
- [ ] i18n Persian RTL + English
- [ ] 5M-bar profiling in the real UI
- [ ] Accessibility pass
- [ ] Windows/macOS installers actually run (built by CI, not tested here)
