# Timezones

## What it looks like

A button in the toolbar that always states the current zone **and its offset** — `New York
(UTC-4)` — so the offset is readable without opening anything. Clicking it opens a searchable
list where every row is `City  UTC±N`, ordered by offset so the list reads as a clock rather than
an alphabet.

- **69 zones**, chosen because a market or a broker lives there, not for exhaustiveness. A
  thousand obscure zones make the picker worse at its job, which is finding your own zone fast.
- **18 market centres** marked with a dot (New York, London, Tokyo, Frankfurt, Sydney…).
- **DST is shown** as a badge on the row, so a one-hour surprise before a session is visible
  rather than discovered.
- **Search** matches the city, the IANA id, the region, AND the offset — typing `+3:30` finds
  Tehran, which is how you look for a zone when you do not know which city name the list uses.

Works identically in live and replay. The reference instant is **the chart's current bar**, not
the wall clock — so a replay of last July shows the offsets that were in force then.

## No offsets are stored

An offset is a function of the zone AND the moment. New York is UTC-4 in July and UTC-5 in
January. A hardcoded table is therefore wrong for half the year, and wrong again after every
DST rule change.

Everything is computed from `Intl`, which carries the platform's IANA database:

```
New York    July UTC-4     January UTC-5
London      July UTC+1     January UTC+0
Sydney      July UTC+10    January UTC+11     (southern hemisphere: inverted)
Tehran      UTC+3:30 always                   (half-hour zone, no DST since 2022)
Kathmandu   UTC+5:45 always                   (quarter-hour zone)
```

Verified live: the toolbar read `UTC (UTC+0)`, picking Tehran produced `Tehran (UTC+3:30)`, and
New York with the chart's own time produced `UTC-4`.

## Two wrong ways to detect DST

Both were written, both were caught, and the way they failed is worth keeping in the file:

**1. `offset !== min(Jan, Jul)`** — got the southern hemisphere backwards. Sydney's *smaller*
offset is its **July** value, which is winter there, so July was reported as DST and January was
not.

**2. The mode of twelve monthly samples** — New York spends **eight months** on DST, so the mode
*is* the DST offset. It reported standard time as DST.

The answer was already in the platform: `timeZoneName: "long"` returns *"Eastern Daylight Time"*
vs *"Eastern Standard Time"* — and *"British Summer Time"* for the European style. That is a
direct answer with no hemisphere assumption and no arithmetic. A zone that has no DST returns
neither word ("Nepal Time", "Iran Standard Time"), and that is the correct verdict.

## A third bug: my own test asserted something false

The live test demanded "New York and Sydney can never both be on DST". That is **not true**: New
York ends DST in early November and Sydney starts it in early October, so those weeks are a
genuine overlap. The test failed, the code was right.

Fixed by asserting the invariant that actually holds — mid-July and mid-January, when the
hemispheres cannot both be in summer — plus an explicit test that **late October 2026 is a real
overlap**. A false invariant is worse than no test: it forbids reality.

## What DST costs a trader

The reason this is worth this much care: a session that starts at 09:30 New York time starts at a
different UTC hour in winter than in summer. A replay that uses today's offset for a January
chart shifts every session by an hour and makes a strategy look like it works at the wrong hour.
Timezones are not cosmetic here.

## Test commands

```bash
bash scripts/timezone-smoke.sh          # 9 live scenarios
npx vitest run tests/timezone-cities.test.ts   # 36 unit tests
```
