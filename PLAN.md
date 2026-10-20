# PLAN

Milestones, current state and risks. Kept current per the working method.

## Status at a glance

| # | Phase | State |
|---|---|---|
| 1 | Foundation: scaffold, core, db, workers, build scripts | **done** |
| 2 | Data and chart: import, symbol specs, aggregation, TZ, chart shell, themes, drawing, quality report | **partial** — import/aggregation/TZ/chart shell done; drawing tools and quality report pending |
| 3 | Replay and trading: account engine, orders, replay, demo accounts, journal, prototype parity | **partial** — engine + replay + hotkeys + indicators done; order types (limit/stop/OCO), SL/TP drag, journal UI pending |
| 4 | Indicators: engine + full built-in list | **partial** — engine + 9 of 15 indicators |
| 5 | Strategy tester: JS API, reports, optimizer, walk-forward, Monte Carlo | **partial** — JS API + full stats done; optimizer/walk-forward/Monte Carlo pending |
| 6 | News and sessions | **not started** |
| 7 | Pine Script | **not started** (decision record pending) |
| 8 | Journal dashboards and exports | **not started** |
| 9 | Polish and release | **partial** — offline verification + headless smoke + screenshot done |

Anything marked partial is listed with what exists and what does not in
`docs/CHECKLIST.md`. Nothing is described as complete that is not.

## Milestone detail

### Phase 1 — Foundation (done)
- Electron 32 + React 18 + TypeScript strict + Vite, bundled locally.
- Columnar candle store (ADR-001), timezone layer (ADR-002/003).
- SQLite schema for accounts/trades/news/settings/workspaces.
- Build scripts: `build`, `build:main`, `test`, `typecheck`, `lint`.
- 147 unit tests, all passing. Typecheck clean under `strict` +
  `noUncheckedIndexedAccess`.

### Phase 2 — Data and chart
Done: CSV parser (both required layouts, delimiter/header auto-detection, UTC
offset, validity rejection), symbol specs with money math, minute/day/week
aggregation with session anchoring, live forming bar, chart shell with
candlestick rendering, timeframe + timezone selectors, indicator overlays,
themes via a single palette object.

Not done: drawing tools (trend line, Fib, channel, text, position tool),
persistence of drawings per symbol, multi-chart layouts, chart types other than
candles, the import dialog with column mapping UI, data-quality report UI.

### Phase 3 — Replay and trading
Done: shared AccountEngine with spread/commission/SL-TP/trailing/partial
close/hedging-vs-netting/stop-out, bar-by-bar replay, play/pause/step/speed/
slider, hotkeys, floating P/L and equity, the forming-bar behaviour.

Not done: limit/stop/stop-limit/OCO orders, swap accrual across days, margin
call (only stop-out at zero equity), SL/TP drag on the chart, the positions
table UI, the equity curve UI, the risk calculator UI.

### Phase 4 — Indicators
Done: SMA, EMA, WMA, RSI (Wilder), Bollinger (population sd), ATR, MACD,
Stochastic, plus crossover/crossunder/highest/lowest helpers. All O(1) per bar.
Not done: VWAP, ADX, CCI, Ichimoku, Parabolic SAR, Supertrend, Volume, Pivot
Points. Per-indicator settings dialog and templates not started.

### Phase 5 — Strategy tester
Done: JS strategy API exactly as specified (`c.i`, `c.bar`, `c.p`, `c.s`,
`c.pos`, `c.ind`, `c.buy`, `c.sell`, `c.closeAll`), compile/runtime error
reporting, next-bar fill with no look-ahead, and the full stats set: count,
win rate, net, profit factor, max DD (money and %), avg win/loss, expectancy,
win/loss streaks, gross profit/loss, Sharpe, Sortino, monthly returns, MAE/MFE.
Not done: optimizer, walk-forward, Monte Carlo, heatmap, "apply best
parameters", open-a-trade-in-replay.

### Phase 6-8
Not started: news import/calendar/markers, session shading, Pine runtime,
journal dashboards and CSV/PDF export.

### Phase 9 — Polish
Done: offline verification script (static + CSP + main-process guards), headless
smoke test that reads the real DOM, screenshot capture via CDP.
Not done: i18n (Persian RTL), installer packaging, auto-update, performance
profiling at 5M bars in the real UI, accessibility pass, USER_GUIDE.

## Risks

1. **2 cores / 3.9 GB on the build box.** `npm install`, `vite build` and
   `electron-rebuild` all fit, but a 5M-bar profiling run and a full Electron
   build cannot run at the same time. Mitigation: measure aggregation and
   backtest throughput in Node (already in tests, 500k bars < 2 s) rather than in
   the UI.
2. **No display.** The app is verified through Xvfb + CDP DOM assertions and
   screenshots. That proves it renders, but interactive gestures (dragging an SL
   line, marquee selection) cannot be exercised for real here. Those need a
   manual pass on a desktop.
3. **`better-sqlite3` ABI.** It must be rebuilt against Electron's ABI
   (`npx electron-rebuild -f -w better-sqlite3`), otherwise the main process
   throws on startup. This is now in `docs/CHECKLIST.md`.
4. **Pine Script is the largest unknown.** The spec allows embedding an existing
   runtime, writing an interpreter, or a hybrid. That choice needs the spike the
   spec asks for, and it is not made yet.
5. **Charts beyond candles** and multi-chart layouts are cheap in Lightweight
   Charts but not yet wired.
