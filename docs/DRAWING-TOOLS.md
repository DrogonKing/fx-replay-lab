# The drawing rail, and per-tool customisation

## The rail follows TradingView's order, not ours

The order and grouping in `TOOL_GROUPS` are TradingView's, deliberately. A user arriving from
that platform reaches for a tool where their hand expects it. Reordering these for tidiness
would break the only thing the rail has going for it, which is muscle memory.

Top to bottom, matching the reference layout:

| # | Entry | Family | Chevron |
|---|---|---|---|
| 1 | cursor / crosshair | — | no |
| 2 | `╱` trend line | Lines | yes |
| 3 | `𝑓` fibonacci | Fibonacci | yes |
| 4 | `✎` brush | Brush | yes |
| 5 | `➤` arrows | Arrows & Patterns | yes |
| 6 | `⊞` projection | Projection | yes |
| 7 | `T` text | Text | yes |
| 8 | `☺` icons | Icons | yes |
| 9 | `▭` shapes | Shapes | yes |
| 10 | `⇕` measure | Measure | yes |
| 11 | `⤢` zoom in | — | no |
| 12 | `∪` magnet | — | no |
| 13 | lock | — | no |
| 14 | hide | — | no |
| 15 | delete | — | no |
| — | gap | | |
| ★ | favourites | — | no |

Chevrons appear only on the grouped families, exactly as in the reference: a chevron on a
plain toggle would promise a menu that does not exist.

## 90 tools, all of them real

The list grew from 65 to 90. Every entry is a kind in `DrawingKind` and draws something; a
button that silently does nothing is worse than a missing button. The additions cover the
gaps against TradingView:

- **Lines** — info line, flat top/bottom, disjoint channel, Schiff / Modified Schiff / inside
  pitchfork
- **Fibonacci** — trend-based fib time, fib circles, fib spiral, Gann square (free and fixed),
  Gann fan (fixed), pitchfan
- **Brush** — highlighter, ellipse arc
- **Shapes** — rotated ellipse, star, arrow shape
- **Text** — anchored text, anchored note, table
- **Icons** — emoji, sticker, image
- **Projection** — price range %, date and price range %
- **Patterns** — 5-0, bars pattern

## Customising a tool

Colour, width (1–4), line style (solid / dashed / dotted), line opacity, fill and fill
opacity, plus **which timeframes the tool appears on**. Reached from the gear in any tool menu,
or right-clicking a family.

### The timeframe filter is the feature that earns its place

A weekly pivot or a swing tool is noise on a 1-minute chart. Being able to say so once — rather
than remembering to ignore it — is what turns a 90-tool rail into a usable one. An empty list
means every timeframe; a family whose every tool is filtered out disappears from the rail
entirely.

Verified live: scoping Trend Line to D1 gives **16 items on M5** (Trend Line absent, the other
16 Line tools present) and **17 on D1**.

### Precedence

An explicit per-drawing value beats the tool default, which beats the shipped default.
`styleFor()` implements exactly that. Reading the tool default first here would make every new
drawing ignore the colour the user just chose.

## Persistence stores only what changed

`serialiseConfigs()` writes only tools where `isDefault === false`. Two reasons:

1. Storing all 90 defaults means a future change to a default never reaches an existing user,
   because their stored copy wins forever.
2. A new tool added in an update appears with its default instead of being invisible until the
   user resets everything — which is why `mergeConfigs()` merges rather than replaces.

Stored in SQLite `settings` under key `tool_configs` (schema v3's `updated_at` column).

## Rendering honours the style

Three things had to carry the style all the way to the canvas, and each was a silent no-op
before:

- `Drawing.style / opacity / fillOpacity` — captured when the drawing is made
- `RenderShape.lineStyle / opacity / fillOpacity` — carried to the overlay
- `InteractionState.style` — widened from `{color, width}` to the full style, so a dashed or
  60%-opaque tool is not narrowed back to a plain line

A line's own `dashed` flag still wins over the tool style, because projection legs are always
dashed by design.

## Tests

`tests/tool-config.test.ts` — 39 tests. The ones that matter:

- an explicit override wins over the tool default
- a new tool still appears after an update (merge, not replace)
- drawdown-style clamping: width to 1–4, opacity to 0–1, non-hex colours rejected
- `dashPattern` scales with width, so a thick dashed line stays dashed
- `serialiseConfigs` writes nothing when nothing changed
- round-trip: serialise → merge → same config

Live smoke: `scripts/tools-smoke.sh` — 7/7.
