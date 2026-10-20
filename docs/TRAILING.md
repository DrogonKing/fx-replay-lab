# Trailing stop and partial close

## Trailing stop

Three modes, chosen in the trade panel. All three only ever **tighten** the stop.

| Mode | Reference | Distance |
|---|---|---|
| **close** | the bar's close | fixed, in price points |
| **high/low** | the bar's high (buy) or low (sell) | fixed, in price points |
| **ATR** | the bar's close | `multiple × ATR(14)` |

**high/low is tighter than close** on the same bar, because it trails behind the extreme
the trade actually reached rather than where the bar happened to end. ATR scales the
distance to current volatility, so the stop is not glued to one fixed width across quiet
and violent sessions.

### The ordering rule that matters

**A trail derived from bar N is only tested from bar N+1.**

This is not a style preference. Applying a trail to the bar that created it closes
winning trades for a loss:

```
entry 2000.2 · bar: high 2030, low 1999, close 2025 · trail 10 points
=> trail price = 2025 - 10 = 2015
=> the SAME bar's low (1999) <= 2015, so the engine reports "stop hit"
=> exit at 2000 for -2.30 on a trade that reached 2030
```

The bar's low happened *before* the close that produced the stop. Testing the stop
against it is applying a decision to a period that preceded it — the mirror image of
look-ahead, and just as wrong.

`applyTrailing()` therefore runs **after** the engine's SL/TP pass. Its effect is visible
from the next bar onward, which is what a trailing stop physically is.

Break-even is the opposite case and runs **before** the pass: it is a one-off jump to a
fixed level, not a per-bar ratchet, so if price reaches the trigger on this bar the stop
should already be there when that same bar is tested.

### Other limits it observes

- never loosens: a candidate worse than the current stop is ignored
- never fires on the bar that created it (see above)
- ATR mode stays inactive until the 14-bar window is full — a short-window ATR would be
  artificially tight for the first bars and then widen, which is look-ahead in disguise

## Partial close

The `½` button on a position row closes half. Sizes that would leave a remainder off the
lot step are **refused** rather than rounded: rounding up closes more than you asked,
rounding down leaves a position you believed was gone.

The closed portion:

- produces its own journal entry tagged `partial`
- splits the commission proportionally, so the remaining position carries its fair share
  of the entry cost
- leaves the stop and target untouched, now protecting fewer lots

### Reading the R of a partial

R is `pnl / money-at-risk`, and the risk is scaled by the lots actually closed:

```
stop distance 60 points, 0.5 lots of gold (contract 100)
  => risk = 60 × 0.5 × 100 = $3,000
  => a $42 profit is 0.014R
```

That is correct and it is worth looking at: a 60-point stop on half a lot of gold risks
$3,000. On a $10,000 account that is 30% at risk on one trade. The small R is the honest
report of a badly sized position, not a bug. R tells you about risk, not about profit.

## Where it lives

- `src/core/trailing.ts` — `trailPrice`, `planPartialClose`, `atrSeries`, `partialTriggerPrice`
- `src/renderer/trading.ts` — `setTrailing`, `applyTrailing`, `closePartial`, `setAtrSeries`
- `tests/{trailing,trailing-session}.test.ts` — 51 tests
- `scripts/trailing-smoke.sh` — 25 stepped bars asserting the trail tightens and never
  closes early, then a partial close reaching the journal
