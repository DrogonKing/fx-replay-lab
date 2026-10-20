# Economic calendar

Import a CSV, see markers on the chart, and — the part that matters — have trading
**refused** inside a high-impact news window.

## Why the blackout is enforced in the engine, not the UI

A disabled button is a hint. A news rule that can be clicked through is decoration. So
`TradingSession.open()` and `placeOrder()` both refuse while a blackout is active:

```
news blackout — high impact USD: Non-Farm Payrolls
```

Closing is **not** blocked. A blackout stops new risk; it must not trap you in an open
trade. Close, close-all and partial close all still work.

## The clock is the replay's, not the wall clock

The blackout is evaluated against the **newest revealed bar**, not `Date.now()`. In a
replay of January 2024, comparing a 2024 calendar against today's date means the blackout
never fires — and a current calendar would block the wrong bars entirely. This was a real
bug in the first version and it made the feature silently do nothing.

## Importing

**Import CSV…** in the NEWS tab. The parser accepts the shapes providers actually export:

| Column | Accepted headers |
|---|---|
| date | `date` |
| time | `time` |
| datetime | `datetime`, `timestamp`, `date/time`, `when` |
| currency | `currency`, `ccy`, `cur`, `symbol`, `pair`, `instrument` |
| impact | `impact`, `importance`, `volatility`, `priority`, `level` |
| event | `event`, `title`, `name`, `description`, `event name` |

**Date and time are usually two columns.** A file with `Date,Time,Currency,...` is
combined into one timestamp; a single `Date` column holding the full datetime also works.
An earlier version mapped both `date` and `time` to the same field and parsed **zero
events** from a standard export.

### Timestamps

Accepted, all read as UTC unless an explicit offset is present:

```
2024-01-05 13:30        2024-01-05T13:30:00Z      2024-01-05T13:30:00+02:00
01/05/2024 13:30        1704456600 (epoch)        1704456600000 (epoch ms)
```

**Day/month order.** `01/05/2024` is ambiguous. Rather than guessing per row, the parser
inspects the file once: if any first component is above 12 it must be a day, so the file
is day-first. Otherwise it assumes month-first, and the **day-first dates** checkbox
overrides that. A row like `25/01/2024` in a month-first file is **rejected with a
reason**, not silently rolled into January 2025.

### Impact

Words (`High`), stars (`***`), numbers (`3`) and verbose labels (`High Impact Expected`)
are all recognised. An unrecognised impact becomes `low` rather than dropping the row —
a missing rate decision is worse than an under-labelled one.

### Bad rows are reported, not swallowed

Rows that fail to parse are counted and listed with their line number, so "6 events from
6 rows" and "6 events from 8 rows, 2 skipped" are distinguishable. Silently dropping
rows makes a calendar look complete when it is not.

## Blackout windows

Default is **±5 minutes for high impact**, nothing for medium or low. Adjustable in the
panel; the window is stored per event so an old import keeps the settings it was made
with.

`currency` is matched against the instrument: a USD event blocks XAUUSD and EURUSD (quote
currency), not EURJPY. An `ALL` event blocks everything.

## Markers

High impact draws a red arrow **below** the bar; medium an amber circle above; low a grey
circle. One marker per timestamp — fifteen events sharing a second would otherwise stack
into an unreadable pile.

Only events inside the visible window are mapped. A marker per event across 30,000 bars
builds tens of thousands of shapes for no benefit.

## What is not done

- **No live calendar feed.** Import is manual; nothing is fetched at runtime, consistent
  with the offline-first rule.
- **No actual/forecast/previous display.** Those columns are parsed by header detection
  but not surfaced; the panel shows time, currency, event and impact.
- **No blackout for manual timer-based strategies** — the rule applies to orders placed
  through this app.
- **No "trade the news" mode.** The blackout can be set to ±0 minutes, which effectively
  disables it without deleting the calendar.

## Where it lives

- `src/core/news.ts` — CSV parsing, timestamp formats, blackout, markers, summary
- `src/renderer/panels/NewsPanel.tsx` — import, table, status
- `src/renderer/trading.ts` — `setBlackout`, refusals in `open()` / `placeOrder()`
- `src/main/db.ts` — the `news` table (existed since v1, first written here)
- `tests/{news,news-blackout}.test.ts` — 65 tests
- `scripts/news-smoke.sh` — import, persist, refuse, and still-allow-close in the app
