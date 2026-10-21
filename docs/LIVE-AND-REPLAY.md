# Live paper trading, and replay

## The two modes

The app now opens on a start screen and asks which you want, because the difference is not
guessable from a toolbar: one moves on its own, the other only when you step it.

| | Live | Replay |
|---|---|---|
| Bars | polled from the provider every 15s | loaded once for a chosen period |
| Clock | moves on its own | step, or play at 1–100 bars/sec |
| Orders fill on | **closed bars** | revealed bars |
| Starting point | the newest bar | a year/month you pick |

Everything downstream — account engine, trade panel, journal, equity curve — is the **same
code**. That is the point of the design: a fill is a fill, whether the bar arrived from a poll
or from a replay step.

**No broker is connected.** Every fill is simulated inside the app. The start screen says so.

## The honest part: the provider's limits

Yahoo's free chart endpoint keeps intraday history for a limited window, and this is a real
constraint, not a preference:

| Interval | History |
|---|---|
| 1m | ~7 days |
| 5m / 15m / 30m | ~60 days |
| 1H | ~2 years |
| 1D / 1W | decades |

`INTRADAY_LIMIT_DAYS` is the single place that knows this. `availability()` returns one of:

- **ok** — the provider covers the whole range
- **clamped** — part of it; `clampedFrom` is the oldest bar, and the message names the date the
  replay will actually start
- **needs-file** — under `MIN_REPLAY_DAYS` (14) of history survives, so "start from the oldest
  available" would be a polite lie: you asked for a year and would get a fortnight
- **unsupported-interval** — the provider has no such interval at all

The year picker is built from `selectableYears()`, so it **cannot offer a year the provider will
refuse**. That is the fix for "I picked 2019 and nothing loaded".

Verified live: 5m offers only 2026; 1D offers 31 years including 2019; 1m reports needs-file
and disables the Load button; forcing 2019 at 5m produces *"The provider keeps 60 days of
5-minute data, so the replay starts at 2026-08-22 instead of the requested date."*

## Why the account only advances on a CLOSED bar

A live poll re-requests a trailing window, so the most recent bar is still **forming** — its
close changes with every poll. Processing it would:

1. fill orders at a price that never existed, and
2. charge commission and swap again on every poll.

`lastProcessedRef` holds the last bar time the account has seen. A poll advances the account
only when `barTime > lastProcessedRef`, which is `shouldAdvanceAccount()`.

`mergeSeries()` is what makes this safe: it **replaces** the forming bar and ignores anything
older, rather than appending. Appending the overlap would duplicate bars and double-charge.

Verified live: 6063 bars before and after two poll cycles — no duplicates.

## A real bug this surfaced

`CandleSeries` carries a `length` field alongside its arrays. The first `mergeSeries` returned
only the arrays, so `merged.length` was `undefined`, and the status line crashed the entire
renderer with *"cannot read properties of undefined (reading 'toLocaleString')"*.

The `as unknown as T` cast **hid the missing field from TypeScript**. That is the lesson: a cast
that silences the compiler can also hide a missing field. `buildSeries()` is now the one place
the shape is assembled.

The smoke test was also lying: it reported `startGone: true, hasChart: false` and read as "the
provider returned no data", when the renderer had crashed and emptied `#root`. It now asserts
`rendererAlive` — a blank page must fail loudly instead of looking like a slow download.

## What is still not real

- **No broker adapter.** Fills are simulated; nothing reaches a market.
- **No real bid/ask.** The spread comes from the symbol spec, not the feed.
- **Yahoo is delayed**, so "live" means "as fresh as a delayed quote", not tick data.
- **5-minute only in live mode** (`pollLive` requests 5m); the interval picker affects the
  initial load, not the poll rate.

These are stated on the start screen and here, rather than implied away.

## Files

- `src/core/session-mode.ts` — `availability`, `selectableYears`, `mergeSeries`, `mergeBars`,
  `newBarIndices`, `shouldAdvanceAccount`, `parseModeState`
- `src/renderer/panels/StartScreen.tsx`
- `src/renderer/App.tsx` — `startSession`, `pollLive`, the poll timer
- `tests/session-mode.test.ts` — 51 tests
- `scripts/mode-smoke.sh` — 5 live scenarios
