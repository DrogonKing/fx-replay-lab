# Drawing tools

Every tool below is implemented in `src/core/drawings-ext.ts` (geometry) and
`src/core/drawing-interaction.ts` (behaviour), rendered by
`src/renderer/overlay.ts`. None of them is a placeholder.

**Geometry is verified by tests.** `tests/drawings-ext.test.ts` (43 tests) and
`tests/drawing-interaction.test.ts` (34 tests) assert things like "a Fib
retracement 0 level equals the impulse end", "the pitchfork median passes through
the midpoint of B and C", and "an XABCD whose AD/XA leaves 0.786-0.886 is
rejected". `scripts/draw-smoke.sh` then drives **real pointer events** in the
running app and counts painted pixels, so a shape that exists in the model but
never reaches the canvas fails the test.

## How to use

Pick a tool from the left rail → the rail groups icons into 9 flyouts. Esc returns
to the cursor. Undo is Ctrl+Z, redo Ctrl+Shift+Z, delete-all is the bin.

| Interaction | Tools |
|---|---|
| **click once** | horizontal line, vertical line, horizontal ray, text, note, callout, price label, arrow marker, flag, comment, signpost, balloon |
| **click-drag** | trend line, ray, extended line, rectangle, rotated rectangle, ellipse, circle, arc, curve, Fib retracement, Fib extension, long/short position, projection, date range, price range, date+price range, measure, arrow |
| **3 clicks** | parallel channel, pitchfork, fib channel, gann fan, gann box, triangle, fib wedge |
| **5 clicks** | XABCD, ABCD, triangle pattern, head & shoulders |
| **6 clicks** | three drives, Elliott impulse, cypher, bat, crab, butterfly, shark |

## Lines

| Tool | Behaviour |
|---|---|
| Trend Line | segment between two points |
| Horizontal Line | full-width line at a price, labelled with the price |
| Vertical Line | full-height line at a time |
| Ray | starts at A, extends through B to the right edge |
| Extended Line | extends both directions |
| Trend Angle | drag then read/adjust the angle in screen degrees |
| Cross Line | one horizontal + one vertical through the same point |
| Horizontal Ray | starts at A, extends right only |

## Channels

| Tool | Behaviour |
|---|---|
| Parallel Channel | base line A→B, parallel through C, filled band |
| Pitchfork | median from the pivot through the midpoint of B and C, parallels through B and C |
| Regression Trend | best-fit line over the span with upper/lower bands |
| Fib Channel | Fib levels drawn as parallels of A→B anchored on C |

## Shapes

Rectangle, rotated rectangle, ellipse, circle, triangle, arc, curve, polygon.
Rectangles and ellipses are defined by two corner points and hit-tested on their
**border**, not their interior, so a click inside can still pan the chart.

## Fibonacci

| Tool | Output |
|---|---|
| Fib Retracement | 7 levels: 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1 — each labelled with ratio and price |
| Fib Extension | 0, 0.618, 1, 1.272, 1.618, 2, 2.618, 3.618, 4.236 |
| Fib Time Zone | vertical lines at Fib multiples of the A→B time span |
| Fib Speed Fan | fan of Fib-slope rays from A |
| Fib Arcs | concentric arcs at Fib radii |
| Fib Wedge | three-ray wedge with Fib spacing |

Levels are computed as `b.price - (b.price - a.price) * level`, so level 0 is the
impulse end and level 1 is its origin.

## Gann

| Tool | Behaviour |
|---|---|
| Gann Fan | 7 rays at 7.5°, 15°, 26.25°, 45°, 63.75°, 75°, 82.5° |
| Gann Box | price/time square with the internal Gann divisions |

## Patterns

Patterns do more than draw: they **validate**.

- **XABCD** computes AB/XA, BC/AB, CD/BC and AD/XA and reports which ratio left its
  tolerance band. Defaults follow the common convention: AB/XA 0.382-0.618,
  BC/AB 0.382-0.886, CD/BC 1.13-2.618, AD/XA 0.786-0.886.
- **ABCD**, **triangle**, **head & shoulders**, **three drives** draw their
  structure and label the legs.
- **Elliott Impulse** checks the three rules that matter: wave 3 is never the
  shortest of 1/3/5, wave 2 never retraces past the start of wave 1, and wave 4
  never overlaps wave 1.
- **Harmonics** (cypher, bat, crab, butterfly, shark) draw their ratio legs.

A pattern that fails validation still draws — it is reported, not hidden, because
seeing *why* it fails is the point.

## Forecast and risk

| Tool | Output |
|---|---|
| Long / Short Position | entry, stop, target box with **R multiple** |
| Projection | projected path box |
| Date Range | bar count and elapsed time |
| Price Range | price delta and percent |
| Date and Price Range | both |
| Ghost Feed | dashed projected bars |

The position tools also compute money at risk for a given lot size:
`risk × lots × contractSize`, so a 0.10-lot gold trade with a $10 stop shows $100.

## Annotation

Text, note, callout, price label, arrow, arrow marker, flag, comment, signpost,
balloon. All anchor to a data point and stay correct across zoom and timeframe
changes.

## Measure

Click-drag to see `Δprice (Δ%)` and elapsed seconds. Bar count needs the active
timeframe, which the caller supplies.

## Persistence

**Not yet.** Drawings live in memory for the session. The SQLite schema has a
`workspaces` table ready for them; wiring it is the remaining work. This is stated
in `docs/CHECKLIST.md` rather than left for you to discover.

## Coordinate space

Everything is stored as `{time, price}` in UTC epoch seconds, never pixels. That is
why a drawing survives zooming, changing timeframe, resizing the window, and
switching timezone — the pixels are recomputed on every frame from the data.
