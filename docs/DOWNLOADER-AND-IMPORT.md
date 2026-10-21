# Downloader, import, and broker data

## The two questions this answers

1. **"Download GBPUSD 2010–2016."** → the downloader, Dukascopy, resumable.
2. **"I already have downloaded data."** → the importer, which sniffs the format.
3. **"Can it use my IC Markets demo login?"** → yes, via a bridge — with a real caveat.

## Downloader

One request per day of 1-minute candles. A day file is ~11 KB compressed → 1440 bars.

### Measured throughput

| Workers | Time for 8 days | Projected for 2557 days |
|---|---|---|
| 1 | 174 s | **929 min** |
| 4 | 43 s | **307 min** |
| 8 | **failed outright** | — |

**4 is the ceiling.** At 8 parallel requests the server stops answering entirely — this is not
a slow path, it is zero throughput. The app clamps to 4 in main, not just in the UI, so the
setting cannot be used to break it.

A 7-year pull is therefore **~5 hours** of wall time. That is the honest number: Dukascopy is
free, and this is what free costs.

### Why it must be resumable

About **1 in 10 files fails** even at 4 workers, and single requests take anywhere from 0.5 s to
45 s. Each completed day is cached as CSV under `history/SYMBOL/YYYY-MM-DD.csv`, so a restart
skips what is done. A failed day is **not** cached, so a second pass retries exactly the gaps.

Verified live: 5 days of GBPUSD 2014-06 → **7200 bars, first 2014-06-02T00:00, last
2014-06-06T23:59, first open 1.6755, max gap 60 s, 0 empty, 0 failed**. Second call served from
cache in **147 ms** with no network.

### The traps, all of which are in the code

| Trap | Consequence |
|---|---|
| Month in the URL is **zero-indexed** | every request shifts a month |
| Records are **open, close, low, high** — not OHLC | a chart with high/low swapped that looks plausible |
| Prices are **uint32 in 1e-5 points**, not float32 | reading as float32 gives all zeros |
| `open == 0` means a minute with no ticks | counting it puts a fake 100% drop in the account |
| Point scale differs for JPY/metals/crypto | a price off by 10x or 100x |

Verified against an independent Python decode of the same file: **1440 bars both ways,
first open 1.6755 both ways, first timestamp 2014-06-02T00:00:00Z.**

## Importer

The format is sniffed from the bytes, not demanded from the user. Recognised:

| Format | Detected by |
|---|---|
| Dukascopy `.bi5` | extension; the date comes from the path (`SYMBOL/YYYY/MM/DD/`) |
| HistData monthly ZIP / CSV | `20240101 000000;O;H;L;C;V` — semicolons, joined date-time |
| MT4 / MT5 export | header naming date and OHLC, or date-first rows |
| TrueFX | `SYMBOL,datetime.ms,bid,ask` |
| generic CSV | delimited numbers |

Verified on real-shaped files: HistData **500/500 rows, 1m spacing**; MT4 export **300/300
rows, header correctly skipped, no header text leaked into the data**.

### The audit is not a rubber stamp

A file that parses is not a file that is usable. On a file built with one impossible bar
(high < low), one duplicate timestamp, one zero price and one corrupt row:

```
bars 4, skipped 2, errors 2, badPrices 1, duplicates 1, verdict "suspect"
notes: 1 bars with a non-positive price, 1 duplicate timestamps, no weekend bars
```

It reports **suspect**, which is the point.

### A real bug this surfaced

An earlier version skipped any non-numeric line as a "header". A corrupt row in the *middle* of
a file was therefore silently eaten and the file reported **zero problems** — the worst kind of
failure, because it looked clean. A header can only be the first line. A follow-up bug in the
same area: three separate skip paths incremented the counter without recording a reason, so
"0 skipped, no errors" was reported for a file full of broken numbers.

## Broker data: the honest answer on MT4/MT5

**MetaTrader has no public HTTP API.** There is no way to POST a login and receive candles.
The supported paths are:

1. The Windows terminal, via the `MetaTrader5` Python package — which ships **`win_amd64`
   wheels only** (verified on PyPI: cp36–cp314, all `win_amd64`).
2. A bridge process the user runs next to their terminal, exposing bars on localhost.

So `bridge/mt5-bridge.py` is that bridge. It is **broker-agnostic**: any MT4/MT5 broker works,
because it reuses the broker's own terminal instead of reverse-engineering a proprietary
protocol. Credentials are used once, in memory, to attach the terminal; nothing is written to
disk.

### What the bridge deliberately cannot do

- no balance, equity, margin, positions or order history
- no order placement, modification or closing
- no credential endpoint at all — `POST` returns 405

That is the design: **an app that cannot read an account cannot leak one.** The user's question
was whether candles could be pulled without touching account data; this is that boundary
enforced in code rather than promised in a document.

### The other adapters

| Adapter | Transport | Windows only |
|---|---|---|
| MetaTrader 4/5 (any broker) | terminal bridge | **yes** |
| OANDA v20 | REST, practice or live | no |
| cTrader Open API | OAuth + protobuf | no |

OANDA is the only one here with a **real bid/ask** in the data (`price=bid|ask|mid`), which is
why it is worth an account when MT5 is not an option. Its forming candle (`complete: false`) is
dropped, so a backtest never depends on when it ran.

## What is still not done

- **The bridge is untested against a live terminal** — no Windows machine here and no
  `MetaTrader5` wheel for Linux. The code follows the documented API, but "it compiles" is not
  "it worked". It needs a run on your machine.
- **Wine is installed** on this host (wine-9.0) but MT5 under Wine needs a display and a full
  terminal install; it is not a path I can verify here.
- **No streaming.** Every adapter pulls bars on request. Tick streaming needs a separate
  long-lived connection, which is a different feature.
- **No broker order routing.** Fills are still simulated.
