# Position management

Three things: level lines on the chart, dragging them, and automatic break-even.
All three are constrained by rules that exist to stop a mistake from costing money.

## The level lines

Every open position draws three dashed lines over the chart:

| Line | Colour | Draggable | Why |
|---|---|---|---|
| entry | gold | **no** | it is history — moving it would rewrite a fill that already happened |
| SL | red | yes | |
| TP | green | yes | |

Each line carries a price tag on the right and a round handle when draggable. They are
painted on top of your drawings, so an SL never hides behind a trendline you forgot
about.

**They are not drawings.** Drawings are annotations stored per `symbol::timeframe` in
SQLite; these mirror live account state and vanish when the position closes. Storing
them as drawings would persist them to disk by accident.

## Dragging

Grab the SL or TP line anywhere on the chart and drag. The rules:

| Position | Stop must stay | Target must stay |
|---|---|---|
| buy (long) | **below** the entry | **above** the entry |
| sell (short) | **above** the entry | **below** the entry |

A drag that breaks the rule is **refused**, the level snaps back, and the reason appears
in gold under the chart:

```
a buy's stop must stay below the entry (1991.91)
```

This matters. Allowing a stop to cross the entry turns a trade into a guaranteed
instant loss — and on a short, a target crossing the entry turns it into a guaranteed
instant win. Both look like the app giving out free money, and both are silently wrong.

A minimum distance from the entry is also enforced, because a level sitting exactly on
the entry is ambiguous (stop or target?) and a market that ticked through it would close
the trade immediately.

## Automatic break-even

Set **auto break-even at** `N` R in the trade panel (0 turns it off). Once a position is
`N`× its initial risk in profit, its stop moves to break-even.

**Break-even includes commission.** The stop does not move to the raw entry price,
because at that price you have still paid the spread and commission:

```
entry 1991.91, commission $0.30 on 0.10 lots of gold (10 units)
      => stop moves to 1991.94, not 1991.91
```

That 0.03 is the round trip to zero. A stop at the raw entry closes the trade slightly
negative, which is not what "break even" means to a trader.

**It only ever tightens.** If the stop is already at or beyond break-even, nothing
happens. Moving a stop backwards would increase risk on a trade that is already working,
and no automation should do that silently.

**It runs before the stop check on each bar.** If price reaches the trigger and then
reverses within the same bar, the stop is already at break-even when that bar is tested —
not one bar later.

### A stop exactly at the entry

If you drag a stop onto the entry, risk becomes zero and the position can never be
stopped out. Break-even reports that honestly rather than claiming success:

```
stop is at the entry — the position has no risk to manage (move it away from the entry first)
```

## One source of truth for money

The open-positions table reads its P/L from `engine.positionPnl()`, not from its own
arithmetic. An earlier version recomputed it and the row disagreed with the account total
by exactly the commission (`+18.70` in the row, `+18.40` in the account) — two numbers for
one position, and the row is the one a trader reads. Recomputation also lost the bid/ask
distinction: a short must be valued at the ask, not the bid.

## Where it lives

- `src/core/position-manage.ts` — pure: lines, hit testing, constraints, R maths, break-even
- `src/renderer/overlay.ts` — `paintPositions()`, drawn after the drawings
- `src/renderer/App.tsx` — `tryGrabHandle()`, pointer drag, `?test=1` hook
- `tests/position-manage.test.ts` — 38 tests
- `scripts/position-smoke.sh` — real pointer drags in the running app
