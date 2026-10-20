# The optimizer surface, and the journal's R calendar

## Why a heatmap and not a ranked table

`optimize()` already returned a ranked list, and a table answers "which combination won". It
cannot answer the question that decides whether the result is worth trading: **is there a
region that works, or did one cell win by luck?**

That is a property of the surface, and it is invisible in a sorted list.

## Two decisions that keep the surface honest

### A collapsed cell keeps the BEST run, never an average

A grid with three parameters puts several runs on one cell. Averaging them invents a parameter
set that **was never tested**, and the invented one can look better than any real run.

### Drawdown is inverted

`higherIsBetter()` returns false for `maxDrawdown`. Without that, the worst region of the
heatmap is the darkest green — the map reads exactly backwards. One property is non-negotiable:
dark green always means good, regardless of metric.

## Roughness is the warning

`roughness()` is the mean absolute step between neighbouring cells, normalised by the value
range:

| Roughness | Reading |
|---|---|
| < 0.25 | smooth — the parameter choice is not sensitive |
| 0.25 – 0.5 | some jaggedness — check neighbours before trusting the winner |
| > 0.5 | very jagged — the grid is fitting noise, not an edge |

A plane rising steadily scores about 0.25; alternating 0/1000 scores above 0.5. A smooth
surface means the winner is probably real. A jagged one means it is probably luck — and that
is the single most useful thing this panel says.

## Applying a parameter set

`paramsForCell()` returns the run's **own** parameters, not a reconstruction from the two axes.
Reconstructing would drop any collapsed dimension and produce a combination that was never
backtested, presented as the best one.

The button fills the fields and stops. It does not re-run: silently replacing the result the
user is looking at is worse than one extra click.

Before this, `req()` hardcoded `params: {}`, so there was no way to backtest a chosen set at
all — the optimizer's output was unactionable.

## The journal R calendar

The journal reported win rate and average R. Neither shows **which days** the damage happened
on, and whether losses cluster. A revenge-trading spiral or a bad-news-day habit is invisible
in an average and obvious in a calendar.

- **R** = profit ÷ risk taken. Zero risk gives R = 0, not Infinity — an Infinity poisons every
  sum and every colour bucket.
- The day is the **exit** day: a trade carried over a weekend belongs to the day the money
  moved.
- Weeks run **Monday to Sunday**. JS gives Sunday = 0, which shifts every calendar by a day;
  `mondayIndex()` corrects it.
- Slots outside the month are `null`, not a zeroed day. A day with no trades and a day that
  does not exist must not look the same.
- Colours are **bucketed**, not a gradient: -2R or worse / loss / scratch / win / +2R or better.
  Buckets mean the same thing in every month; an auto-scaled gradient does not.

### The uncomfortable numbers are the point

The panel leads with worst day, longest losing run and days worse than -2R. A journal that
only shows a win rate is a journal that flatters.

## The report is plain text

`textReport()` produces a greppable, copyable, diffable file. A PDF that cannot be pasted into
a message or compared against last month is less useful than the same content as text.

## Where it lives

- `src/core/optimize-heatmap.ts` — `buildHeatmap`, `normalise`, `roughness`, `paramsForCell`
- `src/core/journal-calendar.ts` — `dailyR`, `buildMonth`, `bucketFor`, `summarise`, `textReport`
- `src/renderer/panels/OptimizerHeatmap.tsx`, `JournalCalendar.tsx`
- Tests: `optimize-heatmap.test.ts` (32), `journal-calendar.test.ts` (45)

## Note on the core/renderer boundary

`journal-calendar.ts` first imported `JournalEntry` from the panel. A type-only import still
breaks it: `src/core` compiled with `--jsx` off cannot resolve a `.tsx` module. The shape now
lives in core and the panel re-exports it, which is also what the spec's "core has no DOM"
rule requires.
