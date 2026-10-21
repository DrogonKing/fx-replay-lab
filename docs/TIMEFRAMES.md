# Timeframes

## The problem with asking first

The start screen used to ask for a timeframe before any data existed. Two things were wrong with
that:

1. **It asks the user to solve a constraint they cannot see.** Whether 5m can cover 2019 depends
   on the provider's retention, which is not on the screen.
2. **It caps them.** Pick 5m and 1m is gone forever, even though the app could have loaded 1m.

## What happens instead

The app loads **the finest resolution its provider can serve for the chosen window**, and every
frame above it is derived by aggregation.

```
window 3 days   -> loads 1m
window 8 days   -> loads 5m     (1m retention is 7 days)
window 200 days -> loads 1H
window 12 years -> loads 1D
```

Verified live: this year resolved to **60 minutes**, twelve years back resolved to **1440**, and
switching back returned to **60** — with `verdict: ok`, so it is loadable rather than blocked.

`finestFor()` is the decision, and it iterates the provider's own retention table rather than a
guess, so it cannot pick an interval that fails to cover the window. A test asserts exactly that
across eight window sizes.

## All frames are listed

The toolbar shows **every** frame the app knows: M1, M5, M15, M30, H1, H4, D1, W1. Frames that
cannot be built from the loaded bars are **marked and disabled** rather than hidden:

```
M1  (needs finer data)     <- disabled
M5  (needs finer data)     <- disabled
H1                          <- usable
H4
D1
W1
```

Hiding them would make "the app doesn't have M5" a reasonable conclusion. Showing them disabled
with a reason makes the situation legible: the data is coarse, not the app.

Verified live on an H1 base: `listsAllMainFrames: true`, usable `[H1, H4, D1, W1]`, blocked
`[M1, M5, M15, M30]`, every blocked one labelled.

## Custom frames

Any length works: `7`, `90`, `3H`, `D3`. Enter applies it. The rules:

- **Coarser than the base → accepted.** 90m from H1 bars works.
- **Finer than the base → refused with the reason**, not silently approximated. 3m from H1:
  `3m cannot be built from H1 bars. Load 3m or smaller data to see this frame.`

Verified live: `90m` was accepted, rendered (`data-frame="90m"`), and appeared in the select.
`3m` was refused with that message and the chart stayed on H1.

## How the base is detected

Four paths feed the chart — provider, file import, Dukascopy download, broker — and not all can
report their interval. So the resolution is read **from the data**: the most common gap between
consecutive bars.

The **mode**, not the mean: weekends and holidays are large gaps, and an average over a month of
1-minute data is dragged upward by every closed session. A test with a weekend gap every 100 bars
still detects 60 seconds.

Sampling keeps it cheap on 40,000 bars, and a duplicate timestamp cannot become the mode.

## Two real bugs this surfaced

1. **`data-bars` reported the base length, not the view length.** Every timeframe switch looked
   identical from outside — 511 bars whatever the frame. The whole point of a derived frame is
   that it draws fewer, wider bars. It now reports the view, with `data-base-bars` and
   `data-frame` alongside.
2. **A custom frame vanished from the select.** After typing 90m, the `<select>` had no such
   option, so its value snapped back to the previous preset while the status line said
   "Timeframe set to 90m" — the control disagreed with the chart. The current frame is now
   appended to the list when it is not a preset.

A third, in my own code: `framesAtOrAbove` compared minutes only when both frames were intraday,
so a **daily base still offered M1/M5/H1**. It now delegates to `canAggregate`, one rule for one
question.

## Verified numbers

```
H1 base   -> 510 bars
W1 frame  ->   6 bars
back to H1 -> 510 bars
```

Fewer bars as the frame grows, and the count is restored exactly on return.

## Test command

```bash
bash scripts/timeframe-smoke.sh
```
