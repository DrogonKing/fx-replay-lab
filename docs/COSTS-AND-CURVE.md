# Costs, equity curve, and what the simulator used to be kind about

## Overnight swap

A position held for a week used to cost **nothing** overnight. That flatters every carry
strategy and makes a multi-day replay a fiction.

`swapFor(side, lots, from, to, rates)` charges each rollover at **21:00 UTC** — the standard
FX rollover, 17:00 New York, when the Fedwire day closes.

### The Wednesday triple charge

Wednesday is charged **3×** in FX: a trade that would settle Saturday settles Monday instead,
so two extra days of financing are taken. Skipping this makes a week of holding cost 5 nights
when a broker charges 7:

```
Mon 00:00 -> Mon 00:00 + 7 days:  7 rollovers
  one of them is a Wednesday -> +2 nights
  = 9 nights of financing
```

`swapRates` defaults to zero, so nothing changes unless a symbol defines rates. The accrual is
written to `position.swap` on every bar and realised into the trade's P&L on close.

## Slippage

Off by default (`DEFAULT_SLIPPAGE.enabled = false`), because an offline replay should be
reproducible before it is realistic.

When enabled, slippage is **deterministic**: a hash of the seed, not `Math.random()`. A replay
must give the same fill on the same bar every time, or a backtest cannot be repeated or
explained. The move is always adverse and never exceeds the configured worst case — an
unbounded random number is neither reproducible nor honest.

Stops get a larger figure than market orders, because a stop is a market order once touched and
liquidity is worst exactly then.

## Margin call, not bankruptcy

The old rule force-closed at **equity ≤ 0**, which is bankruptcy. A broker calls first:

| Level | Ratio | What happens |
|---|---|---|
| ok | > 50% | normal |
| call | ≤ 50% | warned; new risk should be refused |
| stop-out | ≤ 20% | everything force-closed |

`AccountEngine.marginCalled` is the warning state. It does not close anything — that is the
stop-out level's job.

## Equity curve

The backtester already computed `equityCurve` and the replay account tracked a balance, but
nothing drew either. The **EQUITY** tab now does.

**Drawdown is measured against the running peak, not the start.** A $1,000 drop from a $10,000
peak is 10% whether the account started at $5,000 or $20,000. Measuring from the start
understates the drawdown of an account that is up overall — the case where it matters most.

```
balance 10,325.09 · net +325.09 · peak ... · max DD 171.81 (1.7%)
```

### Downsampling keeps the spikes

A 5M-bar backtest cannot draw 5,000,000 points. Taking every Nth point is the obvious approach
and it is wrong: a one-bar crash disappears between samples. `downsampleCurve` keeps the
**minimum and maximum of each bucket** in time order, so a single-bar event survives.

## Chart types and log scale

Candles, bars, line, area — plus a logarithmic price scale. lightweight-charts fixes a series'
type at creation, so switching types **rebuilds the series** and re-points the drawing overlay
(a stale series reference paints every drawing at the wrong height).

Log scale is a price-scale option and needs no rebuild.

## Where it lives

- `src/core/costs.ts` — `rolloversBetween`, `swapFor`, `slippageFor`, `marginState`
- `src/core/equity-curve.ts` — `summariseCurve`, `downsampleCurve`, `fromTrades`
- `src/core/account.ts` — swap accrual on `onBar`, two-level margin call
- `src/renderer/panels/EquityPanel.tsx` — the canvas
- Tests: `costs.test.ts` (39), `costs-engine.test.ts` (12), `equity-curve.test.ts` (22)
