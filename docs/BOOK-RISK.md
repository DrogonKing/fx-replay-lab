# Whole-book risk

Every open position plus every pending order that could still fill, added up and shown as a
percentage of the balance.

## The question it answers

The per-trade panel answers "what am I risking on this trade?". That number is misleading on its
own: three positions at 1% each are each safe and together put 3% at stake. This panel answers
the other question — *what happens if everything goes wrong at once?*

```
book at risk     10.14%
breakdown        open 10.14% · pending 2.00% · 1 no stop
book limit %     0
```

## Off by default

`DEFAULT_LIMIT.maxPercent = 0` — **disabled**. The readout is always live; only the **refusal**
needs a number.

This was a design error caught by the existing test suite. The guard shipped on by default at 6%,
and seven pre-existing tests failed: they opened a position the user had asked for and the guard
rejected it. That is the same mistake as a mandatory session filter — the app deciding for the
user. An app that refuses your tenth trade because of a rule you never set is a gate, not a tool.

## What counts

| Source | Counted |
|---|---|
| Open position with a stop | `|entry - stop| × contractSize × lots` |
| Open position with **no stop** | **not counted** — its risk is unknown, not zero |
| Pending order with a stop | `slDistance × contractSize × lots` |
| Pending order with no stop | not counted |
| An OCO pair | **once**, because only one leg can fill |

A position with no stop is reported as a **count**, never as a zero contribution that makes the
book look safer the less protected it is. The warning is returned even when nothing is breached:

> 1 position(s) have no stop, so their risk is not in this number

## Exposure, separate from risk

`netLots` and `grossLots` are reported too. Four 0.1-lot buys and three 0.1-lot sells are **0.1
net**, not 0.7, and `hedged` is true. Net exposure is not a risk figure and is not mixed into one.

## The guard, when enabled

Checked in `open()` **and** `placeOrder()`, before the engine is called — a limit that only
reports after the fact is a report, not a guard. Pending orders are included, otherwise a limit
order is a way around the rule.

```
book risk — this trade would put 17.24% of the balance at risk, over the 5% book limit
```

**Closing is never blocked.** The limit exists to stop new risk, not to imprison you in a
position — the same rule as the news blackout.

## What is not done

- **No rolling/portfolio VaR, no correlation adjustment.** Two long gold positions are treated
  as 2× the risk, which is close enough; two correlated pairs are not.
- **No per-symbol or per-strategy limits.** One number for the whole book.
- **Pending risk is an estimate.** A stop order can fill with slippage beyond its trigger, so
  the real risk can be larger than the number shown.
- **Not applied to the backtester.** A strategy run sizes itself.

## Where it lives

- `src/core/book-risk.ts` — `positionRisk`, `bookRisk`, `checkLimit`, `headroom`, `describeBook`
- `src/renderer/trading.ts` — `bookRisk()`, `setRiskLimit()`, the guard in open/placeOrder
- `src/renderer/panels/TradePanel.tsx` — the readout, the breakdown, the limit field
- `tests/book-risk.test.ts` — 34 tests; `tests/book-risk-session.test.ts` — 13 integration tests
- `scripts/book-risk-smoke.sh` — the readout, the default-off behaviour, refusal, pending refusal,
  and that closing is never blocked
