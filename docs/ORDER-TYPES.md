# Order types

Four order types, all fill-checked against every replay bar. The rules below are the
specification; `tests/orders.test.ts` (37 tests) asserts each one, including the
directions that are easy to get backwards.

## The rules

| Order | Side | Fills when price… | Fill price |
|---|---|---|---|
| Market | buy | immediately | ask (bid + spread) |
| Market | sell | immediately | bid |
| **Limit** | buy | falls **to or below** the limit | the limit, or the open if it gapped cheaper |
| **Limit** | sell | rises **to or above** the limit | the limit, or the open if it gapped higher |
| **Stop** | buy | rises **to or above** the stop | the stop, or the open if it gapped higher (**worse**) |
| **Stop** | sell | falls **to or below** the stop | the stop, or the open if it gapped lower (**worse**) |
| **Stop-limit** | buy | stop touched, then price ≤ limit | at the trigger price if it satisfies the limit |
| **Stop-limit** | sell | stop touched, then price ≥ limit | at the trigger price if it satisfies the limit |

**Gaps are honoured.** A stop that gaps through its level fills at the open, which is
worse than the stop — the slippage a breakout strategy really pays. A limit that gaps
past its level fills at the open, which is better. Ignoring either flatters a backtest.

## Validation

An order is refused before it enters the book when it would fill instantly, because
that is a market order the user did not ask for:

- buy limit **above** the market → refused
- sell limit **below** the market → refused
- buy stop **below** the market → refused
- sell stop **above** the market → refused

The message states both prices so the correction is obvious:

```
buy limit 2050 is above the market (1991.71) — it would fill immediately;
use a market order or a lower limit
```

Also refused: lots outside the symbol's min/max, a non-positive price, and a
stop-limit whose limit is on the wrong side of its stop.

## OCO (one cancels the other)

Tick **OCO bracket** and the order is paired with a stop on the opposite side at the
same distance as your SL. Both sit in the book; the moment either fills, the sibling is
cancelled.

This is checked **inside** the fill loop, not afterwards. When one bar spans both
levels a naive implementation fills both and opens two opposing positions — the exact
opposite of what OCO is for. `tests/orders.test.ts` locks that case down, and
`tests/orders-session.test.ts` asserts `filled === 1` and one cancelled sibling.

## Stop-limit, precisely

A stop-limit becomes a live limit only at the instant its stop triggers. The fill price
is therefore the **trigger price**, not the bar's open and not the stop:

- stop 2010, limit 2012, price rises through 2010 → fills at **2010**
- price gaps to 2025 (past both) → **armed but unfilled**; it waits for price to come
  back to 2012

Filling at the bar's open would invent an entry the market never offered. This was a
real bug in the first implementation: reviewing the trigger with `limitFill()` made a
rising buy-stop-limit read the bar's open as a favourable gap and fill 35 points below
the stop.

## Interaction with stops and targets

Pending orders are evaluated **before** the engine's SL/TP pass on each bar. A limit
that fills on this bar is a position that existed during this bar, so its stop must be
testable on the same bar. The other order would give every entry one bar of free
protection it never had.

Fills inherit the SL and TP distances typed on the ticket, and the journal entry is
tagged with the order kind (`limit-fill`, `stop-fill`) so you can review performance by
entry type later.

## Limits of this implementation

- **No partial fills.** An order fills whole or not at all; real books fill across
  levels. Stated here rather than left to be discovered.
- **No order expiry** (day/GTC). An order stays until it fills or you cancel it.
- **No trailing stop on pending orders** — trailing applies once a position exists.
- **One spread, applied at fill.** Variable/realistic spread modelling is not done.
