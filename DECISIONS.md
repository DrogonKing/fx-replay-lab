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
