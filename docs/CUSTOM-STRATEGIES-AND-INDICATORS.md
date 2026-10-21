# Custom strategies, indicators, and the strategy tester

Straight answers to three questions, including the ones where the answer is "no".

## 1. Can I add an MT4/MT5 expert advisor (.ex4/.ex5)?

**No, and it is not a matter of effort.**

An `.ex4`/`.ex5` file is compiled MQL bytecode for MetaTrader's own virtual machine, and it calls
MT5 runtime functions — `OrderSend`, `iCustom`, `OnTick`, `OnCalculate`. Running one requires
MetaTrader's terminal to host it. There is no standalone interpreter, no published bytecode
format, and no way to execute one outside the terminal.

Every product that claims "run your MT5 EA in a browser" either drives a real MT5 terminal
underneath (Wine or a Windows VM) or reimplements your logic in another language, which is not the
same EA.

This app takes the honest path: `bridge/mt5-bridge.py` runs **next to your real terminal** and
pulls data. It does not execute EAs. That is a boundary, not a missing feature.

**The practical alternative:** an EA's *logic* can be rebuilt in the app's JavaScript strategy API.
A simple MA-cross EA is ten lines. A 2,000-line EA with custom indicators, DLL calls and order
management is a rewrite, and pretending otherwise wastes your time.

## 2. Can I add a custom indicator?

**Yes, in three ways, and the third is the most useful.**

| Way | Limit |
|---|---|
| Built-in set | SMA, EMA, RSI, ATR, Bollinger, MACD, Stochastic — no code needed |
| Pine Script (a defined subset) | real interpreter, but not full Pine |
| JavaScript strategy body | full language, full control |

### The Pine subset is real but bounded

It is an interpreter for **Pine Script v5's core language**, not a clone. Verified supported:
variables, `var`, history `x[n]`, `for`/`while`/`switch`, user functions, `if` as statement and
expression, and the `ta.*` indicator family it declares.

**Not supported:** `import`, arrays/matrices/maps, and tuple destructuring (`[a, b] = f()`). A
script using those fails with a message naming the construct and the bar — never silently
produces a wrong chart. The full table is in `docs/PINE-COMPATIBILITY.md`.

So: most published indicators that are pure math work. Anything using an array-based loop or a
library import does not.

### The JavaScript API — what actually runs

The strategy body is a function receiving one context object. This is the real API, not an
idealised one:

```js
const fast = c.ind("SMA", 9);          // indicator, cached per (kind, period)
const slow = c.ind("SMA", 21);
if (!isNaN(fast) && !isNaN(slow)) {
  const long = c.pos.some((p) => p.side === "buy");
  if (fast > slow && !long) c.buy(1);              // lots, optional SL/TP distance
  else if (fast < slow && long) c.closeAll();
}
```

| Field | Meaning |
|---|---|
| `c.i` | bar index |
| `c.bar` | `{t, o, h, l, c, v}` current bar |
| `c.p` | parameters, from the JSON field or the optimizer |
| `c.s` | persistent state across bars |
| `c.pos` | open positions, read-only |
| `c.ind(kind, period)` | `SMA EMA RSI ATR BBUPPER BBLOWER BBMIDDLE MACD MACDSIGNAL STOCHK STOCHD` |
| `c.buy / c.sell / c.closeAll` | order intents |

**Two things to know.** First, fills happen at the **close of the signalling bar**, and SL/TP are
evaluated from the **next** bar — filling on the same bar whose high/low produced the signal is
look-ahead, the most common way a backtest lies. Second, the strategy runs in the **main process**,
which means a strategy can execute arbitrary code. That is inherent to running your own JavaScript
and is documented rather than hidden.

## 3. The strategy tester — measured, not described

Real run, real data, real costs. Data came from the app's own Dukascopy downloader:

```
GBPUSD, 5 days, 7200 one-minute bars
2014-06-02T00:00:00Z .. 2014-06-06T23:59:00Z
costs: $3/lot commission each way, 0.2 pip spread
```

SMA 9/21 crossover, both directions, 1 lot:

| Metric | Value |
|---|---|
| trades | **393** |
| net profit | **−2,496.00** |
| ending balance | 7,504.00 from 10,000 |
| win rate | **27.5%** |
| profit factor | 0.65 |
| max drawdown | 2,761.00 (27.1%) |
| expectancy | −6.35 per trade |
| Sharpe / Sortino | −0.14 / −0.18 |
| engine speed | **~70,000 bars/second** |

**The strategy loses money, and that is the useful result.** 393 trades × $6 commission = $2,358 —
so commission alone is 94% of the loss. A crossover on 1-minute bars is a cost-generating machine.
Any tester that showed this strategy profitable would be lying.

### Optimizer

20 combinations of a real grid in **385 ms**:

```
fast=20 slow=60  net=  -1052.00  trades=144
fast=15 slow=60  net=  -1258.00  trades=150
fast=20 slow=40  net=  -1353.00  trades=200
...
positive combinations: 0/20
```

**Zero of twenty were profitable.** A wide spread between best and worst (−1,052 to −3,538) means
the parameters matter — but they matter inside a losing region, which means the *idea* does not
work, not that the right numbers were not found. That distinction is what an optimizer is for.

## A real bug this surfaced

`fast=20, slow=20` never trades — a line cannot cross itself — so it scored net profit **0.00**,
which beat every losing set and was ranked **best**. The optimized result was the parameter set
that did nothing.

That is the classic way an optimizer lies, and it is worse than a wrong number because 0.00 looks
like a safe result. `optimize()` now ranks zero-trade runs **last** regardless of metric, while
keeping them in the output — "this setting cannot trade" is information the user needs.

Two smaller things, both my own errors rather than the app's, worth recording because they cost
time: `BacktestSettings.account` is a full `Account` (`id/name/currency/startingBalance/leverage/
mode`), and `GridAxis` is `{name, from, to, step}` — a range, not a list of values.

## What the tester does NOT do

- **No walk-forward on the result you see by default.** `walkForward()` and `monteCarlo()` exist in
  `optimize.ts`, but the panel does not present them prominently.
- **No tick-level fills.** Bars only, so intrabar SL/TP order is unknowable — a wick that touches
  both is resolved by a rule, not by the real sequence.
- **No live order routing.** Fills are simulated; the broker panel is read-only by design.
- **No multi-symbol portfolio backtest.** One series at a time.
- **Costs are linear.** No swap/financing, no variable spread, no slippage model beyond a flat
  setting.

## Test commands

```bash
node scripts/fetch-test-data.mjs   # pull real bars through the app's own downloader
node scripts/backtest-real.mjs     # run the tester headless on them
npx vitest run tests/optimizer-ranking.test.ts tests/backtest.test.ts
```
