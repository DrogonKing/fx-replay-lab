# PLAN V2 — FX Replay Lab rewrite

Owner: orchestrator (main agent). Implementation is delegated to sub-agents;
this document is the contract they build against. Status markers are updated
by the orchestrator only.

## User requirements (verbatim intent)

1. Live candles from MetaTrader accounts: user enters **login / password /
   server** (e.g. IC Markets demo) inside the app → chart shows that account's
   candles.
2. **No visible MetaTrader window.** The terminal is started by the app, in
   the background, hidden. Nothing opens "next to" the app.
3. Offline mode: **download candle history from the connected MT account**,
   store it locally, and **replay/downloaded data** with zero network.
4. UI/UX redone: **look and feel like TradingView** (dark, same layout
   anatomy). No TradingView logos/assets — palette + layout only.
5. Remove everything not connected to the project. Debug what remains.
6. Paper trading and further features: SPEC LATER (user will define).

## What "rewrite" means here (decision, stated honestly)

The app the user SEES is rewritten from scratch: new shell, new navigation,
new visual system, new login flow, new data path (bridge v2 → main service →
renderer). The proven engines under `src/core` (account/orders/indicators/
aggregation/csv/importer/timezone/persist/drawings — 796 tests) are KEPT as
libraries the new UI mounts. Retyping fixed-and-tested math would re-import
bugs the docs show were hard to find. Everything else is open to change.

## Architecture v2

```
┌────────────────────────── Electron main ──────────────────────────┐
│  mt-service.ts   spawn/kill bridge, health poll, auto-restart     │
│  mt-ipc.ts       mt:connect mt:disconnect mt:status mt:symbols    │
│                  mt:candles mt:latest mt:download mt:cancelDl     │
│  mt-store.ts     SQLite candles table (source-tagged, deduped)    │
│  net.ts          allow-list: 127.0.0.1 bridge + yahoo only        │
└──────────────┬────────────────────────────────────────────────────┘
               │ HTTP 127.0.0.1:PORT + session token
┌──────────────▼──────────────┐
│  bridge/mt5-bridge.py (v2)  │  Python 3.14 + MetaTrader5 pkg
│  POST /connect {login,      │  → mt5.initialize(login,password,
│        password, server}    │     server) — starts terminal
│  window-hider thread        │  → EnumWindows by terminal PID,
│        (ctypes, SW_HIDE)    │     re-hide loop 500 ms, forever
│  GET /health /symbols       │
│  GET /candles?symbol&tf&from&to     (copy_rates_range)
│  GET /latest?symbol&tf&count        (copy_rates_from_pos, live poll)
│  POST /disconnect           │  → mt5.shutdown() (kills terminal it
│                             │     started; leaves user's own alone)
└──────────────┬──────────────┘
               │ terminal IPC (internal)
       [MT5 terminal process — HIDDEN, background]
```

Renderer (React):
```
TopToolbar    symbol pill ▾ · timeframe row · indicators · clock/TZ ·
              LIVE/OFFLINE badge · language · connection dot
LeftIconRail  drawing tools (existing DrawingToolbar, restyled)
ChartCenter   lightweight-charts + OHLC legend + floating ReplayBar
RightSidebar  watchlist ▾ · trade ticket · strategy · news · sessions
BottomDock    positions · orders · journal · equity   (collapsible)
Overlays      LoginOverlay (MT creds | offline entry) · SymbolSearch ·
              DownloadManager (progress, resume) · toasts
```

### Data flow

- **Live**: renderer polls `mt:latest` (interval by TF: M1–M5 → 5 s,
  else 15 s) → merge forming bar (existing session-mode merge logic reused).
- **History download**: DownloadManager → `mt:download {symbol, tf, from, to}`
  → main chunks by month → `/candles` → upsert into mt-store → progress events.
  Resumable: store tracks last-complete chunk; restart skips done chunks.
- **Offline replay**: chart loads from mt-store via `data:load`; replay engine
  (existing) drives AccountEngine. No network path compiled in renderer.
- **Yahoo** stays as the no-account fallback for free history. OANDA/cTrader:
  removed unless audit shows hard wiring that justifies keeping (lean app).

### Candle store schema (mt-store)

```sql
CREATE TABLE candles (
  symbol TEXT NOT NULL, tf TEXT NOT NULL, time INTEGER NOT NULL,
  open REAL, high REAL, low REAL, close REAL, volume REAL,
  source TEXT NOT NULL,            -- 'mt5:<server>' | 'dukascopy' | 'csv'
  PRIMARY KEY (symbol, tf, time)
) WITHOUT ROWID;
```
Columnar arrays are materialized in the renderer from this on load
(existing `CandleSeries` stays the in-memory format).

### Hidden-terminal contract (bridge v2) — refined by bridge audit

- **Startup order fixed**: bind HTTP FIRST, connect lazily on `/login`.
  (v1 connects before binding, so with no terminal running the bridge dies
  before the app can even send credentials — `mt5-bridge.py:419` vs `443`.)
- `POST /login {login, password, server}`:
  1. find terminal (`_find_terminal`, extended: also `%LOCALAPPDATA%\Programs`,
     registry App Paths `terminal64.exe`);
  2. `mt5.initialize(path, login=int, password=..., server=..., timeout=60)` —
     REAL credential login (v1 silently ignores password/server: audit finding);
  3. hide every top-level window of the terminal PID (ctypes `EnumWindows`
     + `GetWindowThreadProcessId` + `ShowWindow(SW_HIDE)`); re-hide watcher
     thread every 500 ms for the first 30 s, then stops (never fight a user
     who deliberately opens MT later);
  4. reply `{ok, account, server, company, symbols, terminalPid, startedByUs}`.
- **Thread-safety**: one global `threading.Lock` around every `mt5.*` call
  (ThreadingHTTPServer + polling + download would otherwise race).
- **Timezone normalization**: MT5 bar times come in the broker SERVER
  timezone. The bridge detects the offset once per connection
  (last bar time vs wall clock, rounded to minute) and returns TRUE UTC
  epoch seconds, plus `serverOffsetSeconds` in `/health` for sanity checks.
- **Chunked history**: `GET /candles` keeps one `copy_rates_range` per call
  (terminal "Max bars" truncates big ranges silently — chunks are mandatory);
  the MAIN process walks month chunks and stores; bridge stays stateless.
- **Shutdown**: `POST /shutdown` → `mt5.shutdown()` (closes a terminal we
  started; leaves a pre-existing one alone). Main calls it on app quit
  (`will-quit` hook — missing today, python process currently leaks), then
  kills the bridge process after a 3 s grace period.
- Credentials live only in bridge process memory, zero disk. Loopback-only
  bind stays; path allowlist in `net.ts` gains `/login` (exists), `/shutdown`,
  and keeps `/candles /symbols /health /timeframes`.

### Python runtime — RESOLVED (exists, keep)

`bridge/python/` already vendors CPython 3.11.9 embeddable + MetaTrader5
5.0.6231 + numpy, isolated via `python311._pth`, shipped by electron-builder
`extraResources`, provisioned by `scripts/fetch-python-runtime.mjs`. Dev
fallback: PATH python. No user installs needed. (System pip on this machine
has a broken proxy; irrelevant while the vendored runtime works.)

## Execution order (each step leaves the app bootable + tests green)

| # | Step | Owner |
|---|---|---|
| 0 | Windows env fixed (node_modules, better-sqlite3@12, rebuild) | orchestrator |
| 1 | Audit: dead code / bridge map / UI inventory | agents A,B,C |
| 2 | Prune dead code per audit A; suite green | orchestrator |
| 3 | Bridge v2 (connect/hide/candles/latest/download) + selftest | bridge agent |
| 4 | Main: mt-service + mt-ipc + mt-store + tests | orchestrator |
| 5 | Renderer: TV design tokens + new shell layout | UI agent |
| 6 | LoginOverlay + live polling wiring | orchestrator |
| 7 | DownloadManager + offline replay wiring | orchestrator + UI agent |
| 8 | Panels migrate into sidebar/dock slots | UI agent |
| 9 | Full verify: typecheck, vitest, boot smoke, screenshots | orchestrator |

## Non-goals for this pass (say so, don't hide)

- Tick streaming (polling only — same as today).
- Real order routing to the broker (paper/simulated fills only).
- Mobile/macOS polish; Windows is the target (MT5 is win_amd64).
- Trading features beyond what exists today (paper trading spec pending).
