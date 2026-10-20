# FX Replay Lab — user guide

An offline-first desktop app for replay trading and strategy backtesting on FX,
gold, indices and crypto. Works fully without a network; adds live data when one is
available.

## Install

| Platform | File |
|---|---|
| Windows (installer) | `FX Replay Lab-<version>-x64.exe` |
| Windows (portable) | `FX Replay Lab-<version>-x64.zip` — unzip and run, no install |
| macOS | `FX Replay Lab-<version>-<arch>.dmg` |
| Linux | `FX Replay Lab-<version>-x86_64.AppImage` or `.deb` |

Unsigned builds: on macOS, right-click → Open the first time. On Windows,
SmartScreen may warn → "More info" → "Run anyway".

## First launch

The app opens with 30,000 bars of built-in sample data so the chart is immediately
usable. Nothing is downloaded.

## Two modes

### Offline (default)

Everything comes from disk: the sample data, an imported CSV, or history you
fetched earlier and kept. No network request is made — this is enforced, not just
avoided: the renderer's Content-Security-Policy sets `connect-src 'none'`.

### Online

Tick **Data → Offline mode** off, then press **Reload history**. The app fetches
from Yahoo Finance through the main process and switches the badge to **LIVE**.

Symbols available: gold futures (`GC=F`, used for XAUUSD), EUR/USD, GBP/USD,
USD/JPY, BTC/USD, S&P 500, Nasdaq 100, SPY.

What the source line means:

| Message | Meaning |
|---|---|
| `Live from yahoo` | fresh data fetched now |
| `Live from yahoo — N bars` | same, with the bar count |
| `rate limit hit — using cached history` | Yahoo refused; you are on stored data, still usable |
| `Offline and nothing cached` | import a CSV |

## Importing candles

**Data → Import CSV**. Both layouts are detected automatically:

```
Date,Time,Open,High,Low,Close,Volume        ← MT4/MT5 export
2024.01.02,10:00,2000.00,2001.50,1999.50,2001.00,10
```

```
timestamp,Open,High,Low,Close               ← epoch s, epoch ms, or ISO
1704153600,2000,2001,1999,2000
```

- Comma, semicolon and tab delimiters are all recognised.
- The header row is optional; if present it is skipped.
- Rows with impossible OHLC (high below low, high below close) are **rejected, not
  patched** — the count is reported so you know the file had problems.
- Newest-first exports are sorted automatically.
- The base timeframe is detected from the median bar spacing.

## Chart

- **TF** — M1 to W1, plus any custom minute count (type `7`, press Enter).
- **TZ** — display timezone. Only the labels change; the data stays UTC.
- **Play / Pause / Step** — Space and → work anywhere outside an input.
- **speed** — 1×, 3×, 10×, 40×.
- The slider jumps anywhere in the loaded history.
- **the left rail** — 60+ drawing tools in 9 grouped flyouts: lines, channels,
  shapes, Fibonacci, Gann, patterns (XABCD/Elliott/harmonics), forecast, annotation,
  measure. See `docs/DRAWING-TOOLS.md` for the full list and how each one behaves.

Pick a tool, then click (one-point tools) or drag (two-point tools) or click
repeatedly (patterns). Esc returns to the cursor. Ctrl+Z undoes, Ctrl+Shift+Z redoes,
the bin deletes everything.

Patterns validate as you draw: an XABCD whose ratios leave the tolerance bands, or
an Elliott impulse where wave 3 is the shortest, is reported rather than silently
drawn as if it were valid.

Replay never reveals the future: the chart can only draw bars up to the current
replay position, so you cannot accidentally see what comes next.

Indicators: SMA, EMA, Bollinger, RSI, ADX, CCI, VWAP, Supertrend.

## Strategy tester

The **STRATEGY** tab runs JavaScript against the loaded series. The account engine
is the same one manual trading and replay use, so a strategy that shows a profit
here produces the same fills when traded by hand.

```js
const fast = c.ind("EMA", 9);
const slow = c.ind("EMA", 21);
if (isNaN(fast) || isNaN(slow)) return;
if (c.s.pf === undefined) { c.s.pf = fast; c.s.ps = slow; return; }
if (c.s.pf <= c.s.ps && fast > slow && c.pos.length === 0) c.buy(0.10, 6, 12);
if (c.s.pf >= c.s.ps && fast < slow && c.pos.length > 0) c.closeAll();
c.s.pf = fast; c.s.ps = slow;
```

| API | Meaning |
|---|---|
| `c.i` | bar index |
| `c.bar` | `{t, o, h, l, c, v}` |
| `c.p` | parameters (supplied by the optimizer) |
| `c.s` | persistent state across bars |
| `c.pos` | open positions |
| `c.ind(kind, period, barsBack?)` | `SMA`, `EMA`, `RSI`, `ATR`, `BB*`, `MACD*`, `STOCH*` |
| `c.buy(lots, slDistance, tpDistance)` | open long |
| `c.sell(lots, slDistance, tpDistance)` | open short |
| `c.closeAll()` | flatten |

**No look-ahead:** a signal on bar *i* fills at bar *i+1*'s open. This is tested
explicitly.

Statistics: trades, net profit, win rate, profit factor, max drawdown (money and
%), expectancy, average win/loss, win/loss streaks, Sharpe, Sortino, MAE/MFE,
monthly returns, ending balance.

### Optimizer

Sweeps parameter ranges (a hard cap prevents runaway grids) and ranks by net
profit, profit factor, win rate, drawdown, Sharpe or expectancy. Truncation is
reported honestly rather than silently returning partial results.

### Walk-forward

Trains on one window, scores on the **next**, non-overlapping one. The
out-of-sample combined result is the number to trust; the in-sample number is shown
next to it so the gap is visible.

### Monte Carlo

Reshuffles trade order 1,000 times. Reports the probability of ending below the
starting balance and the 5/50/95 percentile bands.

### Pine Script

A defined subset of Pine v5 — see `docs/PINE-COMPATIBILITY.md` for the exact list.
Anything unsupported raises a precise error at a bar number instead of silently
producing a wrong chart.

## Journal

**JOURNAL** records trades with tags and notes, then shows win rate and net P/L by
tag, R multiples, and a monthly breakdown. Export writes a CSV.

## Where your data lives

```
Windows  %APPDATA%/fx-replay-lab/fx-replay-lab/
macOS    ~/Library/Application Support/fx-replay-lab/fx-replay-lab/
Linux    ~/.config/fx-replay-lab/fx-replay-lab/
```

`fx-replay-lab.db` is SQLite (accounts, trades, journal, settings). Back it up by
copying that folder.

## Keyboard

| Key | Action |
|---|---|
| Space | play / pause |
| → | step one bar |
| Ctrl/Cmd+Z | undo the last drawing |

## Known limitations

- **Signed builds are not produced.** macOS/Windows will warn on first run.
- **Pine is a subset**, not the full language. No `request.security`, no
  `label`/`line`/`box`, no `import`.
- **No multi-timeframe inside a strategy** — deliberate, to avoid look-ahead.
- **Yahoo data is delayed** and is a continuous futures contract for gold, so
  prices can differ from a broker's spot XAUUSD by the futures basis.
- **Live streaming is polling, not a tick feed.** Bars refresh on reload, not
  tick-by-tick.
- **Drawing tools are session-only** — they are not yet persisted per symbol, so
  they are lost when the app closes. The model and SQLite table exist; the wiring
  does not.
- **Fib fan, arcs, wedge and Gann box** draw their geometry but have fewer
  configurable options than TradingView.
- **Pattern validation is advisory** — it flags ratios outside the usual bands; it
  is not a signal.
- **Journal is not yet persisted** to SQLite from the UI.
- **No auto-update**; the app is offline by design.
- **Tested on Linux only** in this build. The Windows and macOS installers are
  produced by CI but were not run here.

## Troubleshooting

**"Offline and nothing cached"** — turn offline mode off and reload, or import a CSV.

**Live fetch says "rate limit hit"** — Yahoo limits guests. Wait a minute and
reload; cached history keeps the app usable meanwhile.

**Chart is empty after import** — check the bar count in the status line. Zero bars
means every row failed validation; the file probably has a different column order.

**Backtest reports 0 trades** — usually the strategy's indicator returned `NaN` for
the whole series (too few bars, or a period longer than the data). The errors list
under the stats shows any runtime problem.
