# Completing all phases

Target behaviour the user asked for:

1. **Online** -> a live charting experience comparable to TradingView (streaming
   quotes, history backfill, symbol search).
2. **Offline** -> import CSV or download once, then replay and backtest with no
   network at all.
3. **Build on GitHub Actions** -> test, build and package on every push, with the
   artefacts downloadable.

## Execution order (each step ends with green tests)

| Step | Work | Verifiable by |
|---|---|---|
| A | Data provider layer + Yahoo/Stooq adapters + cache | unit tests against recorded payloads |
| B | Live feed orchestration (backfill + poll, offline-aware) | tests with a fake transport |
| C | Remaining indicators (VWAP, ADX, CCI, Ichimoku, SAR, Supertrend, Volume, Pivots) | reference-value tests |
| D | Optimizer, walk-forward, Monte Carlo | statistical invariants |
| E | Drawing model (all tools) + hit-testing + persistence | geometry tests |
| F | News import + replay reveal + avoid-news rule | boundary tests |
| G | Journal analytics + CSV/PDF export | aggregation tests |
| H | Pine subset: lexer, parser, evaluator | classic-script regression tests |
| I | i18n Persian RTL + English | key-parity test |
| J | Workspaces, backup/restore | round-trip tests |
| K | GitHub Actions: test -> build -> package -> release artefacts | workflow file + local dry run |
