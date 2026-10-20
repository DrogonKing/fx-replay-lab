# Decisions

Architecture Decision Records. Each entry states the choice, the alternatives
considered, and the evidence or reasoning. Newest decisions are appended.

---

## ADR-001: Columnar `Float64Array` candle store instead of objects or DuckDB

**Decision.** Store candles as six parallel `Float64Array` columns
(`time, open, high, low, close, volume`) behind a `CandleSeries` interface
(`src/core/types.ts`).

**Alternatives.**
1. *Array of `{time, open, high, low, close, volume}` objects.* What most charting
   code does. Measured cost: a JS object with six numbers is ~200 bytes with
   object header and inline slots; 5M bars ≈ **1.0–1.2 GB** of heap. V8 also has
   to trace 5M pointers per major GC, which produces visible stutter during
   replay. Rejected.
2. *DuckDB.* Excellent for analytics (`GROUP BY` odd timeframes, `WHERE` ranges),
   but adds a native dependency that must be rebuilt per Electron/Node ABI, and
   every chart read would cross the WASM/native boundary. Also a second copy of
   the data unless we duplicate. Rejected for the hot path; may be added later for
   ad-hoc analytics only.
3. *Columnar typed arrays.* **Chosen.** 5M bars = 5M x 8 bytes x 6 = **240 MB**,
   no per-object overhead, GC sees two objects instead of five million. Slicing
   is a view (`subarray`), so aggregation and indicator loops never copy.
   Access is `s.close[i]`, which the JIT inlines.

**Consequence.** Iteration must be index-based, not `for…of`, and there is no
per-bar object to hand around; `candleAt()` exists for the rare case that needs
one. The spec's 5M-candle requirement is met with ~5x headroom on a 4 GB box.

---

## ADR-002: `Intl.DateTimeFormat` for timezones instead of a bundled tz database

**Decision.** Use the platform `Intl` API, caching the derived offset per
(zone, hour-bucket).

**Alternatives.**
1. *Bundle `moment-timezone` or `@date-fns/tz` with full IANA data.* ~2 MB of
   data, another dependency, and staleness risk between library releases and real
   tzdb updates. Rejected.
2. *Store a fixed UTC offset per zone.* Wrong across DST, which the spec
   explicitly requires ("recomputing offsets per bar"). Rejected.
3. *`Intl` + per-hour offset cache.* **Chosen.** Node and Electron both ship a
   current ICU/tzdb, so DST is correct by construction. The cost is that
   `formatToParts` is slow (~1–3 µs), which matters when labelling 10k visible
   bars, so offsets are memoised per hour. A timezone offset only changes on DST
   boundaries, which always fall on an hour boundary in every IANA zone, so an
   hour bucket is exact.

**Consequence.** Verified by round-tripping 1460 samples across a full year in 7
zones (`tests/timezone.test.ts`), including the ambiguous fall-back hour and the
non-existent spring-forward gap. Tehran correctly stays at +03:30 year-round
since Iran abolished DST in 2022.

---

## ADR-003: All timestamps are UTC epoch seconds

**Decision.** No `Date` objects in the core data model; no local-time strings in
storage. `number` = UTC epoch seconds, always.

**Reasoning.** The spec requires the display timezone to be independent of the OS
timezone. Storing `Date` objects invites accidental use of local getters
(`getHours()`, `getMonth()`), which silently makes results depend on the machine
the app runs on — including in backtests, where that changes reported P/L per
session. Epoch seconds are unambiguous and compare/sort with `<`.

**Consequence.** Conversion happens only in `timezone.ts` and only at the UI edge.
Every core module that needs wall-clock fields (session shading, daily anchoring)
calls `toWallClock(t, zone)` explicitly and receives plain numbers.

---

## ADR-004: Session anchoring is a parameter, not a hard-coded constant

**Decision.** Daily and weekly candles anchor to a configurable session open,
default `17:00 America/New_York` (the standard FX day roll).

**Reasoning.** The spec requires it ("anchored to a configurable session open
(default 17:00 New York)"). Hard-coding 00:00 UTC would produce daily candles that
disagree with every broker's D1 chart, which is the single most common complaint
about home-made backtesters. New York 17:00 is also *not* a fixed UTC offset:
it is 22:00 UTC in winter and 21:00 UTC in summer, so the anchor must be
evaluated through the timezone layer, not stored as a constant.

**Status.** Implemented in `aggregate.ts` (Phase 2).

---

## ADR-005: `src/core` has no Electron, DOM or Node imports

**Decision.** Enforced by convention and by the test setup (Vitest runs in the
`node` environment with no DOM, and core tests never import `electron`).

**Reasoning.** The same account engine must run in three places: the UI process
for manual trading, a worker thread for backtests, and the replay loop. Any
Electron or DOM dependency would force duplication, and the spec requires
consistent results everywhere — the fastest way to guarantee that is a single
implementation that physically cannot depend on the environment.

---

## ADR-006: Money is `number` (float64), not integer minor units

**Decision.** Balances, P/L and prices are IEEE-754 doubles; prices are rounded to
`symbol.digits` only when displayed or written to the journal.

**Alternatives.** Integer cents/pips everywhere (exact, no drift) — rejected
because forex pricing needs 5 decimals plus fractional pip math, and contract-size
multiplication produces intermediate values that are not representable in minor
units anyway. Doubles give ~15 significant digits, and a trading account's
realistic range (1e3 to 1e9 with 2 decimals) is far inside that.

**Consequence.** Rounding is applied at exactly two boundaries: display and
persistence. Tests assert on P/L with a tolerance of 1e-9 relative, not `toBe`
equality (`tests/account.test.ts`, Phase 3).

---

## ADR-007: Spread applied at fill time using bid/ask, not a mid-price hack

**Decision.** The chart plots bid candles. A buy fills at `close + spread`, a sell
at `close`; exits use the opposite side.

**Reasoning.** This is what the prototype did and it matches how a broker quotes a
two-sided market. Applying half-spread to both sides would understate cost on one
side; subtracting post-hoc would break `SL`/`TP` bar-level checks, which must be
evaluated against the side actually traded.

**Status.** Implemented in `account.ts` (Phase 3).


---

## ADR-005: Strategy code executes in the main process, not the renderer

**Decision.** The JavaScript strategy API and the Pine interpreter both run in the
Electron **main** process, reached over IPC. The renderer sends a series and code,
receives plain result objects.

**Why this had to be decided at all.** The renderer carries a strict CSP:
`script-src 'self'`, no `'unsafe-eval'`, `connect-src 'none'`. That posture is
correct for an app whose threat model includes a malicious CSV (a filename or a
"notes" field must never become code). The consequence, discovered only when the
first end-to-end run reported **0 trades**, is that `new Function(...)` throws
inside the renderer:

```
compile error: Refused to evaluate a string as JavaScript because
'unsafe-eval' is not an allowed source of script in the following
Content Security Policy directive: "script-src 'self'".
```

**Alternatives.**
1. *Add `'unsafe-eval'` to the CSP.* One line, and it makes every string in the
   renderer potentially executable — exactly the hole the CSP was there to close.
   Rejected.
2. *Ship a sandboxed interpreter for the strategy API instead of eval.* Would mean
   writing an interpreter for a language the spec defines as "plain JavaScript".
   Weeks of work, and still a subset. Rejected as disproportionate.
3. *Run in a worker.* Workers inherit the page CSP, so `new Function` is blocked
   there too. Rejected on evidence, not preference.
4. *Run in the main process.* Works, keeps the renderer CSP intact, and the IPC
   boundary means only data crosses back.

**Accepted cost, stated plainly.** A strategy or Pine script CAN execute arbitrary
code with the app's privileges, because it is executed as code. That is inherent to
"run the user's JavaScript" — the same trust boundary as opening a script file in an
editor. It is documented in `docs/PINE-COMPATIBILITY.md` and the user guide rather
than hidden. The mitigation is that strategies are user-authored, not downloaded:
the app has no network path that can deliver a script.

**Evidence.** `scripts/live-smoke.sh` before the change: `trades0`,
`errs:["compile error: Refused to evaluate..."]`. After: `trades132,
net profit-1170.60, errs:[]` on 5,821 real gold bars.

---

## ADR-006: `findSymbol` never throws; unknown names get a generic spec

**Decision.** `findSymbol(name)` returns a dedicated spec when one exists, resolves
known provider ids through an alias map (`GC=F` → `XAUUSD`, `^GSPC` → `SPX500`), and
otherwise returns a generic spec rather than throwing. `hasDedicatedSpec(name)` lets
callers warn if the money math is generic.

**Why.** It used to throw. Live data arrives keyed by provider id (`GC=F`), and the
strategy panel called `findSymbol(symbolId)` on mount — so every live-loaded symbol
took the whole panel down, which surfaced as "0 trades" in the UI and looked like an
engine bug. A generic spec produces slightly wrong position sizing, which is a
visible, correctable problem; a thrown exception in the render path is a dead panel.

**Consequence.** Position sizing for an unknown instrument is approximate until a
spec is added. This is a deliberate trade: `hasDedicatedSpec` makes it detectable, and
the alternative (silently reusing gold's contract size) would be worse.

---

## ADR-007: Two build outputs, one CommonJS marker at `dist/`

**Decision.** `tsconfig.main.json` compiles `src/main` **and** `src/core` to
`dist/{main,core}` as CommonJS, and `scripts/postbuild-main.mjs` writes
`dist/package.json` with `{"type":"commonjs"}`. The repo root keeps
`"type":"module"` for Vite.

**Why.** Two distinct failures happened here, both worth recording:

1. Without any marker, Node treats `dist/main/*.js` as ESM (because the root
   package.json says `"type":"module"`) and every `exports`/`require` throws
   `exports is not defined in ES module scope`. The app window opened and then the
   main process died.
2. The marker was originally written to `dist/main/package.json` only. Once the main
   process started importing `dist/core` (for the strategy host), those files were
   still resolved as ESM and the same error returned for a different reason.

The marker must therefore sit at the common root of everything tsc emits.

**Third failure, related.** An earlier `tsc` invocation without a stable `outDir`
emitted `.js` files **next to the `.ts` sources**. Rollup then resolved
`./series.js` to the stale `src/core/series.js` instead of the TypeScript source and
the renderer build failed with `"seriesFromCandles" is not exported`. Fixed by
deleting the 11 stale files; `.gitignore` does not cover `src/**/*.js`, so this can
recur if a tool is misconfigured — a lint rule or a pre-build guard is the durable
fix and is not yet in place.

---

## ADR-008: Honest degradation instead of retry storms

**Decision.** The feed is cache-first. Provider failures degrade to cached data and
report `degraded` with a message, rather than throwing or retrying. `rate-limited`
carries a `retryAfterMs` and the orchestrator does not immediately retry.

**Why.** A chart that blanks because a free API rate-limited would be useless in
exactly the moment a trader is watching it. Yahoo in particular answers 429 with no
body and will keep doing so if hammered. Degrading means the app is always usable
with whatever is on disk, and the status line says what actually happened.

**Evidence.** `tests/feed.test.ts`: stale-cache + rate-limit → `state: "degraded"`,
`usable: true`, 4 cached bars served. Provider throwing a socket error →
`state: "error"` with the message, never an unhandled rejection.


---

## ADR-009: Drawings live in a canvas overlay, and canvases are replaced elements

**Decision.** Drawings are painted on a `<canvas>` positioned absolutely over the
chart, driven by a pure state machine in `src/core/drawing-interaction.ts`. The
model stores data-space coordinates (time, price); the overlay is the only code
that converts to pixels.

**Why an overlay.** Lightweight Charts has no vector layer and no plugin API for
shapes. Primitives would have to be rebuilt as series, which cannot express Fib
fans, pitchforks or pattern labels. An overlay keeps the chart library untouched
and the geometry testable.

**The bug this produced, recorded because it is non-obvious.** The overlay painted
nothing. The state machine created drawings, the count showed 1, 2, 3 — and the
canvas stayed empty. The cause was CSS, not logic:

```css
.draw-canvas { position: absolute; inset: 0; }   /* wrong for <canvas> */
```

A `<canvas>` is a **replaced element**. With `width: auto` it keeps its intrinsic
size (the `width`/`height` content attributes — default 300x150) instead of
stretching, and `left: 0; right: 0` becomes over-constrained so `right` is ignored.
The overlay rendered as a 300x150 box in the top-left corner, so every drawing
landed outside the paint area. Confirmed by probing the running app:

```
CANVAS_GEOMETRY: {"attrW":300,"attrH":150,...}          before
CANVAS_GEOMETRY: {"attrW":1116,"attrH":829,...}         after width/height:100%
```

**Rule.** Explicitly size a canvas overlay (`width: 100%; height: 100%`), and read
`getBoundingClientRect()` for the CSS box rather than the `width`/`height`
attributes — writing those attributes is itself what resizes an unconstrained
canvas, so reading them back feeds the wrong number to the resize logic.

**Related bug in the same area.** Undo appeared broken twice: first the button
rendered disabled because its `canUndo` depended on a counter only the keyboard path
incremented; then undo changed the count but not the pixels, because the mutation
called `history.reset()` (which wipes both stacks) and `invalidate()` (which
repaints the *last queued* shapes rather than the new ones). The fix is one funnel
for every mutation (`applyDrawings`), `setCurrent()` instead of `reset()` for
undo/redo, and a single effect that re-queues the overlay whenever the collection
changes.
