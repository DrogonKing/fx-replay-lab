# Walk-forward analysis

## Why it is the only number that counts

A normal backtest reports what a strategy did on data whose parameters were chosen **from that same
data**. That number is always inflated, often completely, and the inflation is invisible: there is
nothing in a "net profit +4,200" to say whether it was found or fitted.

Walk-forward fixes that by splitting time: choose parameters on one stretch (train), then measure
on the next stretch (test) that was never used for fitting — and repeat, rolling forward.

## The bug this feature shipped with

`walkForward` advanced the window by `trainBars` only:

```js
pos = trainEnd;   // wrong
```

So window N's **test** segment became window N+1's **train** segment. Every out-of-sample bar was
later used for fitting, which quietly turns a walk-forward into an in-sample optimisation —
`combinedTest` still looked like a clean out-of-sample figure while being nothing of the kind.

Fixed to `pos = testEnd`. Verified live on real data: before the fix, windows started on
2014-06-02, **06-03**, 06-04, 06-05 (overlapping); after, 06-02, **06-04** — strictly disjoint.
A unit test now asserts that no window's train range intersects any other window's test range.

## Measured on real data

7200 GBPUSD 1-minute bars from the app's own downloader, ECN costs ($3/lot each way, 0.2 pip):

```
train 1440 bars, test 1440 bars  ->  2 windows

  #  train window            best        train net   test net   test trades
  1  2014-06-02 00:00 → 23:59  f20/s60       -166.00    -198.00    31
  2  2014-06-04 00:00 → 23:59  f20/s60        109.00      90.00    20

combined OUT-OF-SAMPLE
  trades        51
  net profit    -108.00
  win rate      33.3%
  profit factor 0.90
```

Two windows is already too few to conclude anything, which the panel says out loud.

## What the panel shows

Explicit controls, not fractions of the data: **train bars**, **test bars**, and which parameter
to sweep. A user can reason about "train 2000 bars"; nobody can reason about "length/4".

The window count is shown **before** running, and coloured by what it means — fewer than three
windows is not a small result, it is **no** result.

Each row shows train net and test net side by side, and a window that was positive in training and
negative out of sample is marked with a warning, because that single row is the whole lesson.

### The verdict, and its guard

After a run the panel states a conclusion instead of leaving a table to interpret:

| Windows | Verdict |
|---|---|
| 0 | the sizes do not fit the data |
| **< 3** | **"cannot distinguish a strategy from luck — shrink the windows"** |
| ≥ 3, all held up | "every window held up out of sample" |
| ≥ 3, none held up after profitable training | "that is curve fitting, not a strategy" |
| ≥ 3, half or fewer held up | "the parameters do not survive unseen data" |
| ≥ 3, mixed | "treat the combined figure as uncertain" |

The `< 3` case is not decoration. The first version declared **"profitable in training,
unprofitable out of sample — that is curve fitting"** from a **single window**. One window is not
evidence of anything; a coin landing heads once is not a biased coin. A tool that states a
confident conclusion from n=1 teaches the user to trust noise, which is the exact opposite of why
walk-forward exists.

Both paths are tested live: at n=1 the panel must say "too few" and must **not** claim curve
fitting; at n=3 it may make a specific claim. Verified: n=1 → `overclaimsOnOneWindow: false`, n=3 →
`"Most windows failed out of sample"`.

## What is still weak

- **`combinedTest.maxDrawdown` is a floor, not the real figure.** Windows are independent runs on
  disjoint data, so a peak-to-trough spanning a boundary cannot be recovered from per-window
  maxima. It is the worst single window, which understates it. Documented in the code rather than
  presented as exact.
- **Anchored rolling, not combinatorial purged CV.** Good enough to expose curve fitting, not the
  state of the art.
- **No purging or embargo** between train and test. With bars this close together, an indicator
  computed near the boundary can leak slightly.
- **Train and test are equal-sized only if you make them so.** The controls allow any sizes,
  including ones that produce a single window — which the panel now warns about rather than hides.

## Test commands

```bash
node scripts/walkforward-real.mjs        # real data, headless, with the verdict logic
bash scripts/walkforward-smoke.sh        # 7 live UI scenarios
npx vitest run tests/walkforward-disjoint.test.ts
```
