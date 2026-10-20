# Risk-based position sizing

Tick **size by risk** in the trade panel and enter a percentage. The lot size is computed from
that budget and the stop distance, and the lots field becomes read-only so it cannot drift from
what you asked for.

## The one rule

**Never risk more than asked.** Everything here follows from it.

The existing `lotsForRisk()` in `symbol.ts` breaks that rule at the bottom of its range: when the
computed size is smaller than the minimum lot it returns `lotMin`, which risks more than the
budget. `planRisk()` refuses instead, and says what the minimum lot would actually cost:

```
the smallest trade (0.01 lots) would risk 5.00 = 0.05% of the balance,
more than the 0.001% asked for
```

The Buy and Sell buttons are **disabled** in that state. A button that is clickable and then
refuses reads as a broken app; a disabled button with the reason above it reads as "this trade is
too big for this account", which is the truth.

## Rounding

| | |
|---|---|
| Direction | **always down**, to the lot step |
| Why | rounding up risks more than the budget; rounding down leaves a little unused |
| Example | $9,867 × 1% = $98.67; stop 500 points on gold = $500/lot; exact 0.1973 → **0.19** |

An earlier version of `normaliseLots()` would have been usable here, but it clamps **up** to
`lotMin`, so a size of 0.004 lots would become 0.01 — a 2.5× over-risk. `planRisk` floors first
and only then considers whether anything is tradable at all.

## Margin can only shrink the size

The risk budget decides first, then available free margin may reduce it. The reverse order would
let margin "allow" a size the user never wanted to risk.

## Units

Points are what the panel collects; price is what the engine needs. One point is `10^-digits` of
price:

```
gold (2 digits):    100 points = 1.00
EURUSD (5 digits):  10 points  = 0.0001
```

The first implementation used `10^(-digits+1)` — a factor of ten too large, which would have sized
every risk-based trade **ten times over**. Caught by a unit test that asserted `100 points = 1.00`
on gold and got `10.00`.

## What the panel shows

| Field | Meaning |
|---|---|
| lots (read-only) | the computed size, or `—` when untradable |
| at risk | money and percent actually at risk at that size |
| margin | what the position will consume |
| reason | why the size was reduced or refused |

## Helper questions answered

- `maxStopPoints(balance, riskPercent)` — "how wide can my stop be at this risk?" in points,
  which is the question a setup with a wide stop actually asks.
- `rewardRisk(sl, tp)` — returns `null` when either side is missing, because an RR computed
  from a missing stop is a number someone will trust.
- `riskOfLots(lots, distance)` — the "you are risking X" line for a size you typed yourself.

## What is not done

- **No per-symbol preset risk.** One percentage, switchable, not saved per instrument.
- **No automatic stop from ATR.** The stop comes from the panel.
- **No "risk of the whole book" guard.** Three positions at 1% each are each 1%; nothing warns
  that the total is 3%.
- **Not connected to the strategy runner.** A backtest still sizes however its strategy says.

## Where it lives

- `src/core/risk-sizing.ts` — `planRisk`, `planRiskFromPoints`, `pointsToPrice`,
  `maxStopPoints`, `rewardRisk`, `riskOfLots`
- `src/renderer/panels/TradePanel.tsx` — the toggle, the read-only lots field, the readout
- `tests/risk-sizing.test.ts` — 27 tests, including the exact case where the old function
  over-risks
- `scripts/risk-smoke.sh` — sizing, the placed order matching, refusal, and scaling in the app
