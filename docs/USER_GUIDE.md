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

## Trading by hand

### Order types

| Type | Use it when | Refused if |
|---|---|---|
| **market** | you want in/out now | — |
| **limit** | you want a better price than the market | a buy limit is above the market (it would fill instantly) |
| **stop** | you want confirmation of a break | a buy stop is below the market |
| **stop-limit** | you want the break but refuse a bad price | the limit is on the wrong side of the stop |

Enter a **trigger** price for limit/stop, and a **limit** price too for stop-limit. Tick
**OCO bracket** to place the order together with a stop on the opposite side at your SL
distance — one cancels the other, which is the usual breakout/breakdown setup.

An order that would fill immediately is refused with both prices in the message rather
than quietly becoming a market order:

```
buy limit 2050 is above the market (1991.71) — it would fill immediately;
use a market order or a lower limit
```

Full rules, gap behaviour and the limits of the implementation:
`docs/ORDER-TYPES.md`.


The **TRADE** tab places market orders on the same account the backtester uses.

| Field | Meaning |
|---|---|
| lots | position size; must be within the symbol's min/max and on the lot step |
| SL (pts) | stop distance in price points, not a price. 10 on gold = $10 of price |
| TP (pts) | target distance, same units |
| tags | comma-separated, saved onto the journal entry |

The panel shows **risk / reward** in account money and the implied R before you click,
so you are never guessing what a stop costs:

```
0.10 lots, SL 10 pts, gold (contract 100)  ->  risk $100
TP 20 pts                                  ->  reward $200  (1:2.00)
```

Buy fills at ask, sell at bid. An order the account cannot margin is **refused** with
the required and available numbers rather than silently opening.

**Stops are checked on every bar as the replay advances**, using the same rule as the
backtester: SL before TP within a bar, gap-through fills at the open. If these never
fire, trading halts — equity has reached zero.

### Moving your stop and target

Your open position draws three dashed lines on the chart: **entry** (gold, not
draggable), **SL** (red) and **TP** (green). Drag the SL or TP line to move it.

The rules are enforced, not advisory:

| Position | Stop must stay | Target must stay |
|---|---|---|
| buy | below the entry | above the entry |
| sell | above the entry | below the entry |

A drag that breaks the rule snaps back and tells you why, in gold, under the chart:

```
a buy's stop must stay below the entry (1991.91)
```

### Auto break-even

Set **auto break-even at** `N` R. Once a position is `N` times its initial risk in
profit, the stop moves to break-even — **including commission**, so on a buy the stop
goes to `entry + commission/(lots × contract)`, not the raw entry. Stopping at the raw
entry would close the trade slightly negative, which is not break-even.

It only ever tightens: if your stop is already at or better than break-even, nothing
moves. Leave it at `0` to turn it off.

### Trailing stop

Pick a mode in the trade panel and a distance:

| Mode | Trails behind |
|---|---|
| close | where the bar closed |
| high/low | the furthest the bar reached — tighter |
| ATR | `N × ATR(14)` — adapts to volatility |

**It only ever tightens**, and it takes effect from the **next** bar. That second rule
is deliberate: a trail calculated from a bar's close cannot be tested against that same
bar, because the bar's low happened before its close. Doing it the other way closes
winning trades at a loss — a $2 loss on a trade that had run 30 points in profit.

### Partial close

The `½` button closes half a position. The closed part gets its own journal row tagged
`partial`, takes its share of the commission, and the stop and target keep protecting
what is left.

Sizes that leave a remainder off the lot step are refused, not rounded — rounding up
closes more than you asked, rounding down leaves a position you think is gone.

**A small R on a partial is not a bug.** R is profit ÷ money-at-risk, and risk scales with
the lots. A 60-point stop on 0.5 lots of gold risks $3,000, so a $42 profit is 0.014R.
That is an honest reading of an oversized position.

### Language

**Language / زبان** in the toolbar switches between English and Persian. The choice is
remembered. Persian flips the whole interface to right-to-left: the panel moves to the
left, the drawing rail to the right.

**The chart is never mirrored.** Time still runs left-to-right and the price scale stays on
the right — a reversed chart would be a bug.

**Numbers stay in Latin digits** in both languages (`1991.71`, not `۱۹۹۱.۷۱`), so prices can
be copied into a broker statement or a spreadsheet and still work.

Known gap: validation messages produced by the engine (for example "buy limit 2050 is above
the market") are still English inside the Persian interface.

### Sessions

**SESSIONS** tab → **shade sessions on the chart**. Pick which of Sydney, Tokyo, London and
New York to draw.

The bands follow **each city's local clock**, so they move with daylight saving: London's
band starts at 08:00 UTC in January and 07:00 UTC in July. That is deliberate — "London opens
at 08:00" means London time, not a fixed UTC hour.

The panel also breaks your journal down by session:

| Session | Trades | Net | Win% |
|---|---|---|---|
| Tokyo | 1 | -50 | 0 |
| London | 1 | +100 | 100 |
| off-session | 1 | +25 | 100 |

Grouped by the session the trade was **opened** in. A trade inside the London/New York
overlap counts as London only, so the counts always add up to the number of trades.

Note that in January the sessions cover 00:00–22:00 UTC, so the only off-session window is
22:00–24:00 UTC — a 21:00 UTC trade is still in New York.

Sessions are drawn and reported only; they do not restrict trading.

### Economic calendar

**NEWS** tab → **Import CSV…**. Any export with a date, a currency, an impact and an event
name works; the parser also accepts `datetime` in one column, epoch timestamps, and impact
written as `High`, `***` or `3`.

If your file uses day-first dates (`25/01/2024`), tick **day-first dates**. Without it a
row like `25/01/2024` is rejected with a message rather than quietly becoming a January
date in the wrong year.

After importing you get:

- impact-coloured markers on the chart (red arrow below the bar for high impact)
- an upcoming table with the next events at or after the replay time
- a status line: **Trading open for USD** or **TRADING PAUSED — …**

**A high-impact window refuses new orders.** The pause is measured against the replay's
own clock, so a January 2024 calendar blocks January 2024 bars, not today. Adjust the
window with **pause ±** (default 5 minutes either side of high impact).

**Closing is never blocked.** A blackout stops new risk; it will not trap you in a
position you want out of.

If some rows fail to parse, a details section lists them with line numbers. A calendar
that silently drops rows looks complete when it is not.

### Closed trades go to the journal automatically

Every close — manual, stop, target, stop-out — creates a journal entry carrying:

- the symbol, side, lots, entry and exit prices and times
- the realised P/L **including commission**
- the money that was actually at risk at entry, so the R multiple is real
- an automatic tag for why it closed: `sl`, `tp`, `manual`, `stop-out`
- any tags you typed when opening

A trailing stop makes the closing stop price different from the initial risk, so the
risk is captured at entry rather than inferred later. A position opened with no stop
records risk 0 and shows "—" instead of inventing an R.

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

`fx-replay-lab.db` is SQLite. Back it up by copying that folder (plus the `-wal`
file if the app is running).

### What is saved, and when

| Data | Saved | Keyed by |
|---|---|---|
| Drawings | 0.6 s after you stop moving | `symbol::timeframe` |
| Journal entries | 0.4 s after a change | entry id |
| Settings | immediately | key |

**Drawings belong to a symbol AND a timeframe.** A trend line drawn on the M5 chart
will not appear on D1 — the same two timestamps mean a different price level there.
Switch back to M5 and it returns.

That also means the drawing count changes when you switch timeframe. That is
intentional, not a bug.

If a stored drawing is ever corrupt (an interrupted write, a hand-edited file, data
from an older version), it is dropped and the status line reports how many. The rest
of your work still loads. On save, anything the reader would reject is refused
before it reaches the file.

### Journal: sample rows are labelled

The **+ Sample** button adds a row tagged `demo` so you can see how the analytics
behave. Those rows are included in the statistics. **Clear samples** removes them.
A real journal with fake rows in it is worse than no journal, so the panel warns
while any `demo` row is present.

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
