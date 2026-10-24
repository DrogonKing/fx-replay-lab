# PLAN

**Superseded by [PLAN-V2.md](./PLAN-V2.md)** — the v2 rewrite (MetaTrader
integration with hidden terminal, TradingView-style UI, MT-backed offline
downloads) is the active plan. This file is kept only as the v0.2.1 history
reference; its phase status below describes the pre-rewrite state.

## v0.2.1 status at a glance (historical)

| # | Phase | State |
|---|---|---|
| 1 | Foundation: scaffold, core, db, build scripts | done |
| 2 | Data and chart | done (import/aggregation/TZ/chart/drawing) |
| 3 | Replay and trading | done (engine, orders, journal, risk) |
| 4 | Indicators | done (16 built-ins) |
| 5 | Strategy tester | done (optimizer, walk-forward, Monte Carlo) |
| 6 | News and sessions | done |
| 7 | Pine Script | subset done |
| 8 | Journal | done |
| 9 | Polish | partial (verified on Linux; Windows verification is v2 work) |

## v2 execution state

See PLAN-V2.md. Environment: the repo now lives on Windows (Node 24,
Python 3.14, MetaTrader 5 terminal installed); the Linux-only smoke suite
was removed with the v2 prune — a Windows-capable e2e path replaces it.
