# Trading sessions

Toggle **shade sessions on the chart** in the **SESSIONS** tab. The panel also breaks the
journal down by session, which is the part that changes behaviour: a wash that only colours
the chart is decoration.

## The four sessions

| Session | Local hours | Defined in | Colour |
|---|---|---|---|
| Sydney | 22:00–07:00 | `Australia/Sydney` | blue |
| Tokyo | 09:00–18:00 | `Asia/Tokyo` | purple |
| London | 08:00–17:00 | `Europe/London` | green |
| New York | 08:00–17:00 | `America/New_York` | orange |

**The hours are local to each city, not UTC.** That is what "London opens at 08:00" means,
and it is not a detail you can skip: London is UTC+0 in winter and UTC+1 in summer, while
New York switches on a different date. A fixed UTC window is an hour wrong for about eight
months of the year.

The band boundaries are computed by taking the city's wall clock on that date, replacing the
time with the session's local open, and converting back through the timezone module. The
offset used is the one actually in force on that day.

### Measured DST behaviour

```
London open, 15 Jan 2024 -> 08:00 UTC   (GMT)
London open, 15 Jul 2024 -> 07:00 UTC   (BST)
```

### The awkward week

The UK switches on the last Sunday of March; the US on the second. Between those dates New
York is on EDT while London is still on GMT, so the gap is **4 hours instead of 5**. Both
opens are still correct at 08:00 local:

```
20 Mar 2024:  London 08:00 UTC, New York 12:00 UTC   (overlap starts at 12:00)
15 Jan 2024:  London 08:00 UTC, New York 13:00 UTC   (overlap starts at 13:00)
```

### Sydney spans midnight

Sydney opens at 22:00 and closes at 07:00 the next day. A bar at 03:00 local belongs to the
session that **opened yesterday**, so the open is searched backwards until the local hour is
at or past the session's opening hour.

## The only genuine gap

In January the sessions cover **00:00–22:00 UTC**:

```
Tokyo     00:00–09:00
London    08:00–17:00
Sydney    11:00–20:00
New York  13:00–22:00
```

So the only off-session window is **22:00–24:00 UTC**. A bar at 21:00 UTC is inside New
York, which surprises people who assume the US session ends at 21:00.

## Statistics attribution

Trades are grouped by the session they were **opened** in, not closed. The decision was made
in that session; a trade carried into another session did not become a different trade.

A trade inside the London/New York overlap is counted as **London only**. The overlap is a
property of the pair, and attributing it to both would make the buckets sum to more than the
number of trades. Use `sessionAtAll()` when you need the overlap as its own label.

The panel asserts this: the counts must add up to the total.

## Drawing

Bands are painted **before** the candles and drawings, at alpha 0.07, so nothing is
obscured. A label is drawn only when the band is at least 40px wide — several narrow bands
with labels would be unreadable, so a band wider than the plot is not labelled at all rather
than printed over its neighbour.

Bands are chart context, not annotations: they live in their own field on the overlay, never
in the drawing model, and never reach SQLite.

## What is not done

- **No session-based filter on trading.** Sessions are drawn and reported; orders are not
  restricted to a session the way they are restricted during a news blackout.
- **No killzones** (the ICT-specific sub-windows like 02:00–05:00 New York).
- **No holiday calendar** — a bank holiday still draws a normal band.
- **No weekend gap handling** — the FX week opens Sunday 22:00 Sydney and the bands simply
  cross the weekend.

## Where it lives

- `src/core/sessions.ts` — definitions, DST-correct opens, spans, attribution, stats
- `src/renderer/overlay.ts` — `paintSessionBands()`, behind everything else
- `src/renderer/panels/SessionsPanel.tsx` — toggles and the breakdown table
- `tests/sessions.test.ts` — 36 tests, including the March DST mismatch and the Sydney tail
- `scripts/sessions-smoke.sh` — bands paint, DST shift, attribution adds up, in the app
