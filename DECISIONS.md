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


---

## ADR-010: Drawings and journal stored as JSON blobs, parsed at exactly one layer

**Decision.** `drawing_sets` holds one row per `symbol::timeframe` workspace with a
JSON payload; `journal` holds one row per entry. Both are validated on the way IN
and on the way OUT by the same pure functions in `src/core/persist.ts`.

**Why a blob instead of a row per shape.** A drawing is a heterogeneous record: a
Fib retracement carries `levels`, a text tool carries `text`, a position tool
carries three points. A relational schema would need a column per optional field and
a migration every time a tool gains a property. The whole set is loaded at once,
never queried by attribute, and per-workspace payloads are a few KB. Row-per-shape
buys nothing here and costs a schema churn on every feature.

**Key by symbol AND timeframe.** A trend line drawn on M5 has no meaning on D1 —
its two points would land at unrelated prices. `workspaceKey(symbol, timeframe)`
keeps them apart. Keying on symbol alone would make drawings appear in the wrong
place after a timeframe switch, which looks like data corruption to the user.

**The bug this design produced, and the rule that fixes it.** Loaded drawings came
back as **"dropped 2 damaged"** while the stored payload was provably perfect:

```
{"version":1,"drawings":[{"id":"dr_…","kind":"hline",
  "points":[{"t":1704201600,"p":2011.5696…}], …}]}
```

The wire format uses short keys `{t, p}`; the in-memory `Drawing` uses
`{time, price}`. `db.loadDrawings` decoded wire → `Drawing`, and then the renderer
called `parseDrawings` on the already-decoded value. The parser read `.t`/`.p` off
objects that only had `.time`/`.price`, got `undefined`, and rejected every shape as
non-finite. The save was always correct; the double decode destroyed the read.

**Rule.** Parse untrusted data at exactly ONE boundary. `db.loadDrawings` now returns
the raw JSON string and the renderer parses once. The type is `RawLoadResult`, so a
second parse cannot compile by accident.

**Reject, don't throw, and report counts.** One corrupt row (crash mid-write, a
hand-edited file, a downgrade) must not make a workspace unloadable. Bad entries are
dropped and the count is surfaced in the status line. On the write path the payload
is round-tripped through the parser *before* it reaches disk, so data the reader
would refuse is never written in the first place.

**Autosave is debounced and gated.** 600 ms for drawings, 400 ms for the journal, and
a `hydrated`/`loading` flag blocks the save effect until the initial load settles.
Without that gate the first render saves the empty starting state over the stored
data — the classic "my work vanished" failure. A drag would otherwise write on every
pointer move.

**Evidence.** `scripts/persist-smoke.sh` draws two shapes, reads the SQLite file
directly (`shapes=2 kinds=['hline','rectangle']`), `kill -9`s the app, relaunches and
asserts `railCount: "2", paintedPixels: 4034`. `scripts/journal-smoke.sh` does the
same for two journal rows and confirms `trades2, net P/L200` after the restart.
`tests/persist.test.ts` round-trips every shape kind and every corrupt-input case.


---

## ADR-011: Manual trading through a session wrapper, and how R gets its denominator

**Decision.** `src/renderer/trading.ts` wraps `AccountEngine` in a `TradingSession`
that (a) keeps the *initial* stop distance per position, (b) files a journal entry for
every closed trade, and (c) is advanced by the replay tick via `onBar`.

**Why a wrapper at all.** The engine is pure and shared with the backtester, which is
correct (ADR-002). But two things it legitimately does not know are needed for a
journal:

1. **The stop distance at entry.** A `Trade` stores `sl` as the price the stop had
   moved to when the position closed. The R multiple needs the distance that was at
   risk when it *opened*. Trailing stops make these different numbers, so the value
   cannot be recovered after the fact — it has to be captured in `open()`.
2. **The user's tags.** Tags are intent recorded at entry, not something the engine
   deals in.

**Risk of 0, never a guessed R.** If a position was opened without a stop, the entry
records `risk: 0` and the journal renders "—". Inventing a denominator would produce a
confident-looking R that means nothing.

**The engine must be advanced, and it was not.** Nothing called `engine.onBar()`, so a
stop placed during replay would never have triggered — the position would sit open
forever while the chart moved past it. The tick is driven from the revealed bar index
in `App.tsx`, and `onBar` is the only place SL/TP are checked, which matches how the
backtester runs the same engine.

**Rejection of unfundable orders.** `open()` refuses an order whose required margin
exceeds free margin. Letting it through would produce negative free margin and an
equity curve that lies about the account's health.

**The bug this produced: a hydrate/drain race that destroyed a trade.** The journal
panel drained the session's pending entries on mount, then the SQLite hydration
resolved and called `setEntries(stored)` — replacing state and discarding the trade
that had just been drained. Because `takePending()` had already emptied the buffer, the
entry was not merely hidden, it was **gone**: the panel showed zero rows and the
database had zero rows while `TradePanel` displayed "Closed (1)".

```
1. place a trade and step:   {"openRows":1,"sections":["Trade","Closed (1)"]}
2. journal db right now:     {"count":0}
3. after opening the tab:    {"domRows":0,"dbCount":0}
```

The fix is that hydration **merges** into current state instead of replacing it:
`setEntries((current) => mergeNewEntries(parsed.value, current).merged)`. Any
load-then-mutate flow needs this shape; "replace with what the server had" is only
correct when nothing can mutate in between.

**Evidence.** `scripts/trade-smoke.sh`: places a buy with a 1-point stop in the real
app, steps 40 bars, and asserts the journal gained a row —
`XAUUSD buy lots=0.1 pnl=-10.30 risk=10.00 tags=['sl','auto-test']` — with
`trades1, net P/L -10, win rate 0.0%` in the panel and one row in SQLite.
`tests/trade-to-journal.test.ts` (18) and `tests/trading-session.test.ts` (19) cover
the mapping, the risk capture, duplicate suppression, and the stop-out halt.

**A stale-process pitfall worth recording.** The smoke scripts used fixed CDP ports.
When a previous `electron` survived a `kill -9` of its `xvfb-run` wrapper, the next run
attached to the **stale** app: the log said `Cannot start http server for devtools`, and
every assertion measured the old bundle while looking perfectly healthy. The scripts now
`pkill` leftovers and pick a random free port.


---

## ADR-012: Pending orders are matched in core, evaluated before SL/TP, and OCO is checked in-loop

**Decision.** Limit/stop/stop-limit matching lives in `src/core/orders.ts` as pure
functions over a bar, not inside `AccountEngine`. The session calls `processBar()`
first on each bar, opens positions for whatever filled, and only then runs
`engine.onBar()` for stops and targets.

**Why separate from the engine.** The engine's job is money: balance, margin, realised
P/L, one rule per fill. Order matching is a different rule set (four directions, gap
semantics, arming) and it is the set most likely to be subtly wrong. Keeping it pure and
separate means each trigger direction can be asserted in isolation; a limit that fills
when it should not is a silent backtest lie, and silent lies are what tests exist for.

**Why before SL/TP.** A limit that fills on bar N is a position that existed during bar
N, so its stop must be testable on bar N. Running the engine first would grant every
entry one bar of protection it never had, and that shows up as an impossible
improvement in any strategy that uses stops.

**Three real bugs this produced, all caught by tests rather than by reading the code:**

1. **Stop-limit filled at the wrong price.** On a same-bar trigger the limit leg was
   checked with `limitFill()`, which asks "did price come down to the limit?". For a
   *buy* stop-limit the limit sits *above* the market while price rises through it, so
   `limitFill` read the bar's open as a favourable gap and filled 35 points below the
   stop. The correct rule: a stop-limit becomes a live limit at the **trigger price**,
   accepted only if that price satisfies the limit; otherwise it stays armed.
2. **OCO filled both legs.** Sibling cancellation ran after the fill loop, so a single
   bar spanning both levels filled both orders and opened two opposing positions — the
   exact opposite of one-cancels-the-other. The check now happens inside the loop, with
   a set of groups that have already fired.
3. **`reset()` kept the order book.** "New session" left stale pending orders that
   would fire against the fresh account as soon as replay resumed.

**Refusing instant fills.** A buy limit above the market, a sell limit below it, a buy
stop below it, a sell stop above it — all would fill at once and are refused with both
prices in the message. Silently converting them to market orders would take a decision
the user did not make.

**Evidence.** `tests/orders.test.ts` (37) covers all four directions for both order
kinds, gap semantics both ways, arming, OCO, and validation. `tests/orders-session.test.ts`
(20) covers the session integration including `filled === 1` for a two-level OCO bar.
`scripts/orders-smoke.sh` drives the real UI: places a buy limit below market, gets the
refusal above market with the exact message, steps 60 bars until the fill
(`buy 0.1 @ 1990.71`, floating +71.20), and places an OCO pair (`buy limit 1990` +
`sell stop 1980`, both tagged `waiting · OCO`).

**Not done, and stated in the docs:** no partial fills, no order expiry (day/GTC), no
variable spread. Real books fill across levels; this fills whole or not at all.


---

## ADR-013: Position levels are painted state, not drawings; constraints live in core

**Decision.** Entry/SL/TP lines are queued separately from `Drawing[]` on the overlay and
their rules live in `src/core/position-manage.ts` as pure functions.

**Why not reuse Drawing.** A drawing persists per workspace in SQLite and is the user's
annotation. A position level mirrors account state and must disappear when the position
closes. Modelling them as drawings would persist them, restore them next launch, and
leave a stop line on the chart for a position that no longer exists. `queue()` therefore
takes a separate `positionLevels` argument painted after the drawings, so an SL is never
buried under a trendline.

**Constraints in core, not in the drag handler.** A stop crossing the entry is not a UI
problem, it is a money problem: a buy with its stop above the entry is a guaranteed
instant loss, and a sell with its target above the entry is a guaranteed instant win.
Keeping the rule in core means it holds no matter who moves the level — the pointer
handler, a keyboard nudge, or a future trailing-stop feature.

**Break-even includes commission.** Stopping at the raw entry leaves the trade slightly
negative once the spread and commission are paid, which is not what a trader means by
break-even. The zero-P/L price is `entry ± commission / (lots × contractSize)`.

**Break-even runs before the stop check on the same bar**, so a bar that reaches the
trigger and then reverses finds the stop already moved.

**Two bugs found by running it rather than by tests:**

1. **The level lines were invisible after a fill.** The session subscription called
   `overlay.invalidate()`, and `invalidate()` repaints the *last queued* shapes — which
   knew nothing about a position that had just opened. It looked fine after any chart
   interaction (which re-queues) and wrong otherwise. The fix is to re-queue from the
   subscription, not just invalidate: `invalidate()` is a repaint, not a state update.
2. **The test hook never installed.** `loadFile()` ignores a query string placed in the
   path, so `?test=1` never reached the page and three assertions downstream failed with
   confusing `undefined` errors. `loadFile(path, { query })` is the supported way, and the
   launch flag is an explicit `--fx-test` (never a default).

**A third bug the screenshot caught that no test would have:** the open-positions table
recomputed P/L itself — omitting commission (row `+18.70`, account `+18.40`) and losing
the bid/ask distinction via a no-op `side === "buy" ? price : price`. It now reads
`engine.positionPnl()`. Two implementations of money arithmetic always drift, and the one
the trader reads is the wrong one to drift.

**Evidence.** `scripts/position-smoke.sh` in the real app: lines painted
(`stopLinePixels: 3328`, `targetLinePixels: 3298`), a genuine pointer drag moved the stop
`1971.91 → 1966.91`, a drag toward the entry was refused with
`"a buy's stop must stay below the entry (1991.91)"` and the stop unchanged, and
auto break-even at 0.2R moved the stop to `1991.94` (= entry + 0.03 commission) while the
position stayed open.


---

## ADR-014: A trailing stop is applied after the bar, never within it

**Decision.** `applyTrailing()` runs **after** `engine.onBar()`, while `autoBreakEven()`
runs **before** it.

**The bug that forced this.** Trailing was applied before the SL/TP pass so that "a stop
tightened on this bar can protect this bar". That reasoning is wrong, and the failure is
silent and expensive:

```
entry 2000.2 · bar: high 2030, low 1999, close 2025 · trail distance 10
trail = 2025 - 10 = 2015
engine then tests this SAME bar: low 1999 <= 2015  ->  "SL hit"
exit 2000, pnl -2.30, on a trade that had touched 2030
```

It was found by a smoke test that asserted a position was still open after one bar and
found it closed. Unit tests on `trailPrice()` alone could not catch it: the function was
correct, the *call site* was wrong.

The stop level is derived from the close, and the bar's low occurred before that close.
Testing the level against that bar applies a decision to a period that preceded it — the
mirror image of look-ahead. The causally sound rule is that the trail protects bar N+1.

**Why break-even stays before the pass.** Break-even is a one-off jump to a fixed level
(the entry, plus commission), not a per-bar ratchet. When price reaches the trigger on a
bar, moving the stop there and then testing that bar is correct, because the level does
not depend on where the bar closed.

**Why `trailPrice` takes no next-bar data.** The structural guarantee is the signature:
it receives one bar and cannot see another. The ordering rule above is what the caller
must respect; keeping the function ignorant of later bars means a future caller cannot
reintroduce the bug by "helpfully" passing more context.

**Clamp removed from `trailPrice`.** An earlier version clamped a buy's trail to the
bar's low, reasoning that a stop above the low would fire on that bar. Since `low <= close`
on any normal bar, the clamp could only ever rewrite a valid, tighter stop *down* to the
low — every trail collapsed to the bar low and trailing did nothing. Where a stop sits is
the user's choice; whether it fires is the SL check's job.

**A guard removed too.** `trailPrice` also refused any candidate above the entry for a
buy, on the theory that a trail should not "lock in more than the move made". That is
exactly what a trailing stop is for, and the guard blocked every useful trail after price
ran. Both errors were caught by writing the tests from the specification rather than from
the implementation.

**Partial close refuses off-step remainders** instead of rounding. Rounding up closes more
than asked; rounding down leaves a position the user thinks is gone. A refusal with the
reason is the only honest option.

**Evidence.** `scripts/trailing-smoke.sh`, 25 stepped bars:
`firstSL 1984.39 -> lastSL 1988.26, tightened true, closedEarly -1, stillOpen true`, then
`½` reduced 1.0 -> 0.5 with the position still open and a `partial` row (+42) reaching the
journal. 556 tests across 24 files.


---

## ADR-015: The news blackout runs on the replay clock and is enforced in the engine

**Decision.** The blackout window is evaluated against the newest revealed bar's time, and
`open()` / `placeOrder()` refuse while it is active. Closing is never blocked.

**Why the replay clock.** The first version passed `Date.now()` into the panel. In an app
whose entire purpose is replaying history, that is nonsense: a January 2024 calendar
compared against today never fires, so the feature silently did nothing while looking
correct in the UI. The time must come from the bar the user is looking at. This is the
same class of mistake as the trailing-stop ordering bug — plausible code, wrong clock.

**Why in the engine.** A disabled button is a hint; a rule that can be clicked through is
decoration. The trade panel also disables Buy/Sell, but that is feedback, not enforcement.

**Why closing stays open.** A blackout exists to stop new risk. Trapping a user in a
position they want out of because a news event started is worse than the exposure it
tries to prevent.

**Parsing decisions, each from a real export shape:**

1. **Date and time are separate columns** in most provider CSVs. Mapping both aliases to
   one field parsed **zero events** from a standard `Date,Time,Currency,Impact,Event`
   file. Date, time and datetime are now three distinct columns and are combined.
2. **A single `Date` column may hold the full datetime.** The header check must accept
   `date` alone, or those files are rejected wholesale.
3. **Day/month order is decided per file, not per row.** `01/05/2024` is ambiguous on its
   own. The parser inspects the file for a first component above 12 to settle it, and a
   `dayFirst` flag can override. A row like `25/01/2024` in a month-first file is rejected
   with a message rather than silently rolled into the wrong month — the same honesty rule
   the CSV candle importer uses.
4. **An unknown impact becomes `low`, not a dropped row.** Losing a rate decision because
   its impact column said "Volatility: 2/3" is worse than under-labelling it.

**Bad rows are reported with line numbers.** "6 events from 6 rows" and "6 from 8, 2
skipped" must be distinguishable, or a calendar looks complete when it is not.

**Markers are capped one per timestamp and limited to the visible window.** Fifteen events
sharing a second stack into an unreadable pile, and 30k bars of markers is tens of
thousands of shapes for no benefit.

**Evidence.** `scripts/news-smoke.sh`: tab present, `6 events from 6 rows` with
`3 / 2 / 1` impact split, 6 rows in SQLite, `marketRefused: true` with
`"news blackout — high impact USD: Non-Farm Payrolls"`, pending order refused identically,
and `opened 1 → closed 1` proving closing still works. 621 tests across 26 files.


---

## ADR-016: `dir="rtl"` on `<html>` is the entire direction mechanism

**Decision.** Direction comes from one attribute on the document element. No per-component
`rtl` props, no mirrored stylesheet, no `[dir]` overrides for anything the layout engine
already handles.

**Why.** CSS Grid and Flexbox mirror themselves when the document direction is RTL: column
one moves to the physical right, and a row flex container starts from the right. That gives
the panel on the left, the rail on the right and a reversed toolbar for free.

**The bug.** The first version "helped" with explicit overrides:

```css
[dir="rtl"] .app {
  grid-template-columns: 280px 1fr 44px;
  grid-template-areas: "toolbar toolbar toolbar" "panel chart rail";
}
```

Those columns are the LTR columns reversed, which cancels the mirror the engine had already
applied. Measured in the app: `panel offsetLeft 1160, chart 44, rail 0` — byte-for-byte the
LTR layout. The smoke test caught it only because it asserted `panelLeft < chartLeft`
instead of trusting that setting `dir` had done something.

**Rule.** Do not add direction-aware layout rules for grid or flex. Only things the engine
cannot know need a rule: font stack, line-height, and letter-spacing (Persian has no
cursive joins to preserve in Latin type, but Arabic script needs vertical room).

**Numbers stay Latin and LTR.** Persian-Indic digits were rejected: prices and P/L are
copied into broker statements and other tools, and `۱۹۹۱.۷۱` cannot be searched or pasted.
Digits carry `direction: ltr; unicode-bidi: isolate` so the bidi algorithm cannot reorder
them inside an RTL sentence.

**The catalogue is typed and tested.** `missingKeys`, `extraKeys` and a placeholder-parity
check run in the test suite. A half-translated UI is worse than an untranslated one, and an
empty button is invisible; a missing key therefore renders as the key itself.

**Known gap.** Core validation messages (`"buy limit 2050 is above the market..."`) are
English strings produced by `src/core/`, surfaced verbatim in a Persian panel. Translating
them means either threading a formatter through the pure core (which would make the core
depend on presentation) or mapping error codes at the renderer. Error codes are the right
answer and are not done yet; the docs say so rather than the UI pretending otherwise.

**Evidence.** `scripts/i18n-smoke.sh`: `dir` flips ltr→rtl, tabs become
داده/معامله/اخبار/اندیکاتور/استراتژی/دفتر, `panelLeft 0 < chartLeft 280`, `railLeft 1396`,
`asciiDigits true / persianDigits false`, and the choice survives `location.reload()`.
649 tests across 27 files.


---

## ADR-017: Sessions are defined in each city's local clock, never as UTC windows

**Decision.** A session's hours are its city's local hours, converted through the timezone
module per bar. No fixed UTC boundary anywhere.

**Why.** "London opens at 08:00" is a statement about London's clock. London is UTC+0 in
winter and UTC+1 in summer, and New York changes on a different Sunday, so a hardcoded UTC
window is wrong for roughly eight months of the year — and wrong in a way that looks fine in
a January backtest and quietly misattributes every London trade from April onwards.

**The awkward week.** The UK switches on the last Sunday of March and the US on the second,
so between them the London/New York gap is 4 hours instead of 5. Both opens are still 08:00
local: on 20 March 2024 that is 08:00 and 12:00 UTC, not 08:00 and 13:00. This is asserted in
the tests, because it is exactly the window a fixed-offset implementation gets wrong.

**Sydney spans midnight.** A bar at 03:00 Sydney belongs to the session that opened at 22:00
*yesterday*. The open is searched backwards until the local hour is at or past the opening
hour, otherwise every Sydney trade in the small hours would be attributed to a session
starting 19 hours later.

**Offsets are resolved iteratively.** `localToUtc` converts, re-reads the offset at the
result, and repeats up to three times. Near a DST boundary the offset at the naive guess
differs from the offset at the true instant, and a single pass lands an hour off — the same
class of bug already fixed in `timezone.ts`.

**Attribution:** open time, not close time, and the London/New York overlap counts as
**London only**. The overlap is a property of the pair; counting it as both would make the
session buckets sum to more than the number of trades. `sessionAtAll()` exists for the cases
that genuinely need both names. The sessions panel asserts the counts sum to the total.

**Bands are painted first**, at alpha 0.07, before candles and drawings. They are chart
context, not annotations, so they live in their own overlay field and can never be persisted
to SQLite by accident. Labels are skipped below 40px width: several narrow labelled bands
are unreadable.

**A gap in the UI wiring, caught by the smoke test.** Adding the `sessions` tab to
`App.tsx` without adding `tab.sessions` to the catalogue rendered the raw string
`tab.sessions` in the rail. Catalogue completeness tests could not see it — the key never
existed in English either. A second test now asserts that every tab id the UI renders has a
label in every language.

**Evidence.** `scripts/sessions-smoke.sh`: four sessions with local hours and colours,
`4034 -> 400981` overlay pixels when shading is enabled, `January 08:00 / July 07:00 UTC
shiftedByOneHour true`, Tokyo 1/-50 · London 1/+100 · off-session 1/+25, `sum 3, netSum 75,
noDoubleCounting true`. 685 tests across 28 files.


---

## ADR-018: A restored session must not be re-exposed to the bar it was saved at

**Decision.** `importState()` records the last bar index the session was already exposed to
(`restoredThrough`), the chart seeds its bar cursor from it, and bar processing is gated on
the restore attempt having settled.

**The bug.** After a restore the position came back in the database and in the restore notice
but not in the engine: it had been stopped out on the first tick. Two independent causes, both
ordering:

1. **A rebuild effect discarded the restored instance.** State was seeded with a hardcoded
   `new TradingSession("XAUUSD")` plus an effect on `[symbolId]`. The real symbol at mount was
   `GC=F`, which differs from the default, so the effect fired on the very first commit and
   replaced the session. The restore imported into an instance the UI then threw away. The
   initial state is now built from the real symbol, and a ref guards the effect so it fires
   only on a genuine change.
2. **A bar was processed before the restore landed.** The restore is an async IPC round trip;
   effects are synchronous. The bar effect ran first, against an empty engine, with
   `lastBarRef` still at -1. Setting the skip afterwards was too late. Bar processing is now
   gated on `restoreSettled`.

Even gated, the bar at the save point must be skipped: the position was already tested against
it, its low may be below the restored stop, and re-testing closes the position the moment it
comes back. This is the same rule as ADR-014 (a trailing stop derived from a bar may not be
tested against that bar) and ADR-015 (the news blackout must run on the replay clock): **a
decision must never be applied to a period that has already passed.**

**Refusal over partial restore.** A corrupt session is refused with the reason. Restoring two
of four positions leaves a balance that no longer explains the positions — a simulator showing
a profit that never existed. `parseSessionState` therefore rejects the whole session if any
position, order or trade fails validation.

**No structural discrimination on a shape that owns the field.** The first validator returned
`Position | { reason: string }` and the caller tested `"reason" in parsed`. `Trade` has a real
`reason` field (its exit reason), so every valid trade was treated as an error and `"TP"` was
collected as the rejection message — no session containing a trade could be restored. Replaced
with an explicit `ok` discriminator.

**Exit reasons are a compile-time list.** A hand-written array listed three reasons that do not
exist and omitted three that do, so a session containing a stop-out trade was unrestorable. Now
a `Record<ExitReason, true>`: adding a reason to the union fails the build here.

**SIGKILL is the test, not a clean quit.** A graceful shutdown could hide a missing autosave
behind an exit handler. Surviving SIGKILL proves the state was written when it changed.

**Evidence.** `scripts/live-session-smoke.sh`: `buy 0.2` open with one pending order ->
SIGKILL -> row on disk `balance 9999.40 positions 1 pending 1 revealed 2000` -> relaunch ->
`positions 1, lots 0.2, side buy, SL 1951.91`, notice `restored balance 9999.40 · 1 open · 1
pending` -> dismiss -> `0` rows. 722 tests across 29 files.


---

## ADR-019: Risk sizing rounds down, and refuses rather than over-risking

**Decision.** `planRisk()` floors the computed size to the lot step and returns `lots: 0` with
`overBudget: true` when even the minimum lot would exceed the budget. It never rounds up.

**Why.** `lotsForRisk()` in `symbol.ts` — written earlier and correct in its normal range —
returns `lotMin` when the computed size is below it. That silently risks more than the user
asked: on a $100 account with a 50-point gold stop, a request for 0.1% ($0.10) produces the
minimum lot, which risks **$50 = 50%**. A tool whose entire purpose is "risk this much" must not
do that. The comparison is asserted in the tests so the divergence is deliberate, not accidental:

```
lotsForRisk(100, 0.1, 50, GOLD)  -> 0.01   (over-risks by 500x)
planRisk(... same inputs ...)    -> 0      (refuses, with the reason)
```

**The refusal carries the arithmetic**, so the UI can say "the smallest trade would risk 5.00 =
0.05%, more than the 0.001% asked for" instead of a bare "invalid size". A refusal that explains
itself is a feature; one that does not reads as a bug.

**The buttons are disabled in that state.** First implementation left them enabled and let
`place()` refuse. That is the worse of the two: a clickable button that refuses looks broken, while
a disabled button under a warning reads as "this trade is too big for this account".

**Margin may only shrink the size, never grow it.** The risk budget decides first; free margin is
then applied as an upper bound. The reverse order would let margin availability "allow" a size the
user never asked to risk.

**Units: one point is `10^-digits`.** The first version used `10^(-digits+1)`, ten times too large,
which would have sized every risk-based trade ten times over — a $500 risk on a $100 budget. Caught
by a test that asserted `100 points = 1.00` on gold and got `10.00`, before any of it reached the
UI.

**The lots field is read-only in risk mode.** Letting the user type over a computed size would let
them believe they are risk-sized when they are not, which is the same lie by a different route.

**Evidence.** `scripts/risk-smoke.sh`: controls present; `1% + 500 points` on a live balance of
$9,867 gives `0.1973 -> 0.19`; the placed order is `0.19` and matches the computed expectation;
`0.001%` gives `lots "—"` with `buyDisabled true` and the arithmetic in the warning; and the size
scales `0.5% -> 0.09, 1% -> 0.19, 2% -> 0.39`. 749 tests across 30 files.


---

## ADR-020: The whole-book risk limit is off by default

**Decision.** `DEFAULT_LIMIT.maxPercent = 0` — disabled. The risk readout is always shown; the
refusal requires the user to enter a number.

**Why.** The guard first shipped enabled at 6%, and the pre-existing suite caught the consequence:
seven tests that opened positions failed. They were not asserting anything about book risk — they
opened a trade the user asked for and were refused by a rule the user never set. That is the same
mistake as a mandatory session filter: the app deciding which trades are acceptable. A tool
reports; it does not police unasked.

The distinction worth keeping: **information is always on, gates are opt-in.** The book
percentage, the breakdown, the unprotected count and the headroom are always computed and
displayed. Only the refusal is conditional.

**A position with no stop contributes UNKNOWN risk, not zero.** Counting it as zero would make the
book look safest exactly when it is least protected. It is excluded from the money total and
reported as a count, and the warning is returned even when no number is breached — an entirely
unprotected book reads 0.00% and *must not* report "fine".

**Checked in both entry points.** `open()` and `placeOrder()` both call the guard before the
engine, because a limit order is otherwise a way around the rule: the risk simply appears later,
when it fills. An OCO pair counts once, since only one leg can fill; counting both would refuse a
legitimate hedge.

**Closing is never blocked**, matching the news blackout: the guard exists to stop new risk, not
to imprison the user in a position.

**Exposure is reported separately from risk.** `netLots` and `grossLots` answer a different
question, and averaging them into a single "risk" number would make both wrong.

**Evidence.** `scripts/book-risk-smoke.sh`: clean book reads `0.00%` with the limit field at `0`;
two 0.5-lot positions take it to `5.07%` then `10.14%`; with the limit off a third trade is
allowed and the book reaches `15.22%`; setting `5%` refuses with `this trade would put 17.24% of
the balance at risk, over the 5% book limit`; a pending order is refused with the same message;
`closeAll()` closes 3 of 3 and files 9 trades. 796 tests across 32 files.
