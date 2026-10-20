# Custom symbols, and Persian messages for core refusals

## Symbol manager

Eight instruments ship hardcoded. A broker's real contract size, lot step or spread for
anything else is not in this repo and cannot be guessed.

**SYMBOLS** tab: add a symbol, and it overrides a built-in of the same name — which is the
point of adding XAUUSD, to correct a guessed contract size.

### Validation refuses instead of repairing

Every rule exists because getting it wrong produces plausible, wrong money:

| Rule | Why |
|---|---|
| `contractSize > 0` | a wrong value silently multiplies **every** P&L by that factor |
| `lotStep` divides `lotMax` | otherwise the largest size is not orderable |
| whole `digits` from 1 to 8 | a fractional digit breaks every price round |
| name without spaces | the workspace key is `symbol::timeframe` |
| no duplicate names | two rows for one instrument, one of them wrong |

A refused form reports **every** problem at once, not just the first.

Stored in `settings` under `custom_symbols`, which needed a **v3 migration**: `CREATE TABLE IF
NOT EXISTS` does nothing on an existing database, so the new `updated_at` column would have been
missing on every upgraded install.

## Persian messages for core refusals

`src/core` is DOM-free and has no idea what language the UI is in, so it cannot return Persian.
Until now it returned English text that leaked into the Persian UI verbatim: a Persian trader
reading "buy limit 2050 is above the market".

The fix is not to translate strings in core. It is to give each refusal a **stable code** and let
the renderer look the message up.

```ts
coreError("not_enough_margin", "not enough margin", { need: 250, free: 100 })
```

`localiseError(message, t)` classifies the existing English, pulls the numbers out, and returns
the translated sentence with the broker's actual figures.

### Unknown refusals stay English, deliberately

A brand-new refusal with no catalogue entry returns its English text rather than a generic
"something went wrong". The specific sentence is the only clue the user has.

### The tests pin placeholder parity

A `{a}` that survives in English and not in Persian silently drops the number from the
sentence — which is how a translated message ends up less useful than the English one.

## Where it lives

- `src/core/symbol-manager.ts` — `mergeSymbols`, `validateSymbol`, `specFromForm`, `parseSymbols`
- `src/core/errors.ts` — `coreError`, `classifyEnglish`, `localiseError`
- `src/renderer/panels/SymbolsPanel.tsx` — the manager
- Tests: `symbol-manager.test.ts` (30), `errors.test.ts` (16)
