# Pine Script compatibility

This is an **interpreter for a defined subset** of Pine Script v5, not a clone.
The table below is the complete list of what runs. Anything outside it fails with a
message naming the construct and the bar — it is never silently ignored, because a
chart that looks correct and is wrong is worse than an error.

Verified by `tests/pine-parse.test.ts` and `tests/pine-runtime.test.ts`
(35 tests). A classic script that produces the same numbers as the equivalent
built-in indicator is the acceptance bar, and that is asserted directly: the SMA
and RSI outputs are compared value-by-value against `src/core/indicators.ts`.

## Language

| Feature | Status | Notes |
|---|---|---|
| `//@version=5` | ✅ | detected; v4 accepted but not separately emulated |
| `indicator(...)` | ✅ | `overlay`, `title` (first positional) |
| `strategy(...)` | ✅ | header only; order functions below |
| variables `x = ...` | ✅ | per-bar |
| reassignment `x := ...` | ✅ | replaces the current bar's value |
| `var` / `varip` | ✅ | persists across bars |
| history operator `x[n]` | ✅ | real lookback over stored series |
| comments `//` | ✅ | |
| strings (single/double quote) | ✅ | |
| numbers incl. `1.5e-3` | ✅ | |
| arithmetic `+ - * / %` | ✅ | division by zero yields `na` |
| comparison `> < >= <= == !=` | ✅ | |
| logic `and or not` | ✅ | short-circuits |
| ternary `?:` | ✅ | |
| `if / else if / else` | ✅ | as statement *and* as expression |
| `for ... to ... by` | ✅ | capped at 10,000 iterations |
| `while` | ✅ | capped at 10,000 iterations |
| `switch` | ✅ | including subjectless comparison arms (`> 100 => ...`) |
| user functions `f(a,b) =>` | ✅ | pure, parameters shadow globals |
| tuples `[a, b]` | ⚠️ | literal parses; destructuring assignment NOT supported |
| `import` | ❌ | not supported |
| arrays / matrices / maps | ❌ | not supported |

## Built-ins — series

| Function | Status |
|---|---|
| `open high low close volume time` | ✅ |
| `hl2 hlc3 ohlc4` | ✅ |
| `bar_index` | ✅ |
| `na` | ✅ |
| `nz(x, y)` | ✅ |

## Built-ins — `ta.*`

| Function | Status |
|---|---|
| `ta.sma` `ta.ema` `ta.rma` `ta.wma` | ✅ |
| `ta.rsi` `ta.atr` | ✅ |
| `ta.macd` | ✅ (returns the MACD line only) |
| `ta.stoch` | ✅ (%K only) |
| `ta.bb` | ✅ (middle band only) |
| `ta.crossover` `ta.crossunder` | ✅ |
| `ta.highest` `ta.lowest` `ta.highesthigh` `ta.lowestlow` | ✅ |
| `ta.change` | ✅ |
| `ta.pivothigh` `ta.pivotlow` | ✅ |
| `ta.barssince` | ❌ returns `na` (needs a condition-history slot) |
| `ta.vwap` `ta.supertrend` `ta.adx` `ta.cci` `ta.ichimoku` `ta.sar` | ❌ not exposed (the indicators exist in `indicators-ext.ts`; wiring is pending) |
| `ta.correlation` `ta.stdev` `ta.dev` `ta.linreg` | ❌ |

## Built-ins — `math.*` / `str.*`

| Function | Status |
|---|---|
| `math.abs max min round floor ceil sqrt pow log sign avg` | ✅ |
| `math.random` `math.sum` | ❌ |
| `str.tostring length toupper tolower contains tonumber` | ✅ |
| `str.format` `str.substring` `str.split` | ❌ |

## Output

| Function | Status |
|---|---|
| `plot(x, title=, color=, style=)` | ✅ line/histogram/columns |
| `plotshape(cond, title=, style=, text=)` | ✅ |
| `plotchar` | ✅ (treated as plotshape) |
| `hline(price, title=, color=)` | ✅ |
| `bgcolor` | ✅ when the colour is a literal |
| `fill` `plotcandle` `plotbar` `label.new` `line.new` `box.new` | ❌ |
| `alert()` `alertcondition()` | ❌ |

## Strategy

| Function | Status |
|---|---|
| `strategy.entry` | ✅ emits an order |
| `strategy.exit` | ✅ with `stop` / `limit` |
| `strategy.close` `strategy.close_all` | ✅ |
| `strategy.order` | ✅ |
| `strategy.position_size` | ✅ |
| `strategy.position_avg_price` | ❌ returns `na` |
| `strategy.equity` `strategy.netprofit` | ❌ |

## Inputs

| Function | Status |
|---|---|
| `input.int` `input.float` `input.bool` `input.string` | ✅ declared, defaults returned, surfaced to the UI |
| `input.color` `input.source` `input.timeframe` | ⚠️ parsed; value treated as its default |
| `input.session` `input.symbol` | ❌ |

## Explicitly not implemented

- `request.security()` — multi-timeframe data. Deliberately absent: a naive
  implementation is the single easiest way to introduce look-ahead into a
  backtest, and a wrong one is worse than a missing one.
- `table.*`, `label.*`, `line.*`, `box.*` — drawing objects.
- Libraries (`import`) and `export`.

## Known differences from TradingView

1. **Repainting.** TradingView repaints `security()` and some `var` patterns on
   realtime bars. Here every bar is closed before it is evaluated, so results are
   reproducible but may differ from a live TradingView chart on the forming bar.
2. **`ta.bb` / `ta.macd` return single values.** Full tuple destructuring is not
   implemented, so scripts that use `[mid, upper, lower] = ta.bb(...)` will not
   parse.
3. **Numeric precision.** Same IEEE-754 doubles, but summation order differs in a
   few rolling indicators, so values can differ in the last 1-2 decimals.

## Trust boundary (important)

A strategy in the tester and a Pine script in the editor are executed as code.
They run in the **main process**, not the renderer, because the renderer's CSP
blocks `new Function`. This means a script CAN execute arbitrary code with the
app's privileges. That is inherent to "run the user's JavaScript" and is the same
trust boundary as opening a script file in any editor. Only run scripts you trust.
