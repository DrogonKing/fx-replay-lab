# Live session persistence

Close the app with a position open and it is still there when you reopen it. Same for
pending orders, the balance and the replay position.

## Why this matters

Without it, the app is a toy: you can be 40 points into a trade, close the window, and the
trade never existed. That is the difference between a simulator and a demo.

## What is saved

| Saved | Not saved |
|---|---|
| balance, stopped-out flag | candle data (reloaded from the source) |
| open positions (side, lots, entry, SL, TP, commission) | order history of filled/cancelled orders |
| pending orders, including OCO groups | settings (separate table) |
| closed trades of the session | drawings (separate table) |
| the replay cursor (`revealed`) | |

A session is keyed by **`symbol::timeframe`**, like drawings. A gold M5 session does not
restore into a EURUSD M15 workspace.

## SIGKILL, not a clean quit

The smoke test kills the process with **SIGKILL** and then relaunches. A graceful quit could
hide a missing autosave behind an exit handler; if the state survives SIGKILL, it was written
when it changed, not on the way out.

Autosave is debounced 800ms and driven by the session's **own subscription** rather than a
React dependency: positions and the balance change inside `onBar()`, which does not re-render
`App`, so an effect keyed on props would persist stale state.

## The restore prompt

A note appears under the chart: `restored balance 9999.40 · 1 open · 1 pending`, with a ✕ that
clears the stored row and starts clean.

Sessions with nothing to lose are **not** offered: no positions, no pending orders, no trades,
and the balance equal to the starting balance. Prompting to resume nothing makes the prompt
meaningless over time.

## Refusal instead of partial restore

A corrupt session is **refused with the reason**, not partly applied. Restoring two of four
positions leaves a balance that no longer explains the positions, which shows a profit that
never existed. The same rule as the CSV importer and the drawing loader.

## Three bugs this feature cost

### 1. `"reason" in parsed` collided with a real field

The validator returned `Position | { reason: string }` and the caller discriminated with
`"reason" in parsed`. But `Trade` **owns** a `reason` field (its exit reason), so every
successfully parsed trade was classified as a failure and `"TP"` ended up in the error list —
meaning no session containing a trade could ever be restored.

Fixed with an explicit `{ ok: true, value } | { ok: false, reason }` discriminator. A
structural check against an object that legitimately has a field of the same name is never
safe.

### 2. A hardcoded exit-reason list rejected valid trades

The validator listed `"StopOut"`, `"Order"`, `"Session"` — none of which exist — and omitted
`"Net"`, `"Signal"` and `"Stop-out"`, which do. A session containing a stop-out trade was
unrestorable.

The list is now a `Record<ExitReason, true>`, so adding a reason to the union **fails the
build here** instead of silently invalidating stored sessions.

### 3. The first bar was re-processed, stopping the position out on arrival

The position came back in the DB and in the notice, but not in the engine. Two causes, both
ordering:

- **A rebuild effect threw the session away.** The state was seeded with a hardcoded
  `new TradingSession("XAUUSD")` and an effect on `[symbolId]` immediately replaced it, because
  the real symbol (`GC=F`) differs from the default. The restore imported into an instance the
  UI then discarded. Now the initial state is built from the real symbol and a ref guards the
  effect so it only fires on a genuine change.
- **A bar was processed before the restore landed.** The restore is an async IPC round trip
  while effects run synchronously, so the bar effect ran first, against an empty engine. It is
  now gated on `restoreSettled`.

Even with the gate, the bar the position was opened on must not be re-tested: it already
happened, and its low can be below the restored stop, which closes the position the instant it
returns. `importState()` records `restoredThrough` and the chart seeds `lastBarRef` from it —
the same "a decision must not be applied to a period that already passed" rule as the
trailing-stop ordering fix.

## Where it lives

- `src/core/session-state.ts` — validation, round trip, `worthRestoring`, `describeSession`
- `src/renderer/trading.ts` — `exportState()`, `importState()`, `restoredThrough`
- `src/main/db.ts` — the `live_sessions` table, one row per workspace
- `tests/session-state.test.ts` — 35 tests, including every exit reason
- `scripts/live-session-smoke.sh` — open, SIGKILL, relaunch, assert, dismiss
