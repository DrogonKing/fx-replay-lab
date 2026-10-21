# Historical candles: which source, and how accurate

Measured on this host, 2026-10-21. Scripts: `scripts/probe-hist*.py`, `probe-accuracy.py`,
`probe-diff.py`.

## Verdict

**Dukascopy is the best free historical source.** Real ticks, real bid/ask, no key, no account,
and **1-minute candles back to 2005** — verified at 2005, 2008, 2012, 2016, 2020, 2024, each a
complete 1440-minute day.

**TwelveData is the best free *API*** — 5000 bars per request, 8 req/min, 800 credits/day.
Enough depth that 1-minute reaches back ~4 days and daily reaches back to 2007.

Neither is "low error" in the sense a vendor claims. The measured number is below.

## Dukascopy

### Depth, verified

```
2024: 1440 minutes  first +    0s  last + 86340s
2020: 1440 minutes  first +    0s  last + 86340s
2016: 1440 minutes  first +    0s  last + 86340s
2012: 1440 minutes  first +    0s  last + 86340s
2008: 1440 minutes  first +    0s  last + 86340s
2005: 1440 minutes  first +    0s  last + 86340s
2003: no data
```

A complete day every time — 1440 minutes including the flat weekend-style bars, which is what
you want for replay: a missing minute would look like a gap in the chart.

### One request per day, not per hour

```
BID_candles_min_1.bi5   11714 bytes -> 34560 bytes -> 1440 records
```

Do NOT use the hourly tick files for candles: `BID_candles_hour_1.bi5` returns **404** — that
path does not exist. The tick files (`00h_ticks.bi5`) are one per hour, so a day of ticks is 24
requests, and they are slow (1–60s each).

### The record layout is not documented

Each 24-byte record:

| bytes | type | meaning |
|---|---|---|
| 0–3 | uint32 BE | seconds from midnight UTC |
| 4–7 | uint32 BE | open, in 1e-5 points |
| 8–11 | uint32 BE | **close** |
| 12–15 | uint32 BE | **low** |
| 16–19 | uint32 BE | **high** |
| 20–23 | float32 BE | volume |

Note the order is **open, close, low, high** — not OHLC. Reading the four prices as float32
gives all zeros, which looks like corrupt data rather than a wrong layout. Verified:
`1440/1440 usable records`, `O=1.10366 C=1.10374 L=1.10366 H=1.10376`.

### Reliability is the real cost

The feed returns **503 in bursts** and single requests took 1–60 seconds. Ten retries with a
4-second pause was what it actually took to get a file. This is fine for loading history and
useless for a live stream.

## TwelveData

5000 bars per request at every interval:

```
1min   5000 bars  2026-10-18 01:06 -> 2026-10-21 12:25
5min   5000 bars  2026-10-04 03:50 -> 2026-10-21 12:25
1h     5000 bars  2026-03-27 04:00 -> 2026-10-21 12:00
1day   5000 bars  2007-12-14       -> 2026-10-21
```

Free tier: **8 requests/minute, 800 credits/day**, 1 credit per time-series call.

## The accuracy number

Comparing 1-minute closes for EURUSD on 2026-10-20, Dukascopy against TwelveData:

```
median   6.00 pip
p25      3.00 pip
p75     12.00 pip
p95     28.00 pip
max     70.00 pip
within 1 pip:  7.2%
within 5 pip: 41.5%
```

**6 pips median disagreement between two reputable free sources on the same minute.** That is
not a bug in either feed; it is what "free FX data" means:

- **Different liquidity providers.** Dukascopy is a Swiss bank with its own book; TwelveData
  aggregates elsewhere. Their last-traded prices genuinely differ.
- **Bid vs mid.** The Dukascopy file used here is `BID_candles`; TwelveData reports a mid.
  Half a typical 0.4–0.5 pip spread is not 6 pips, so this explains only part of it.
- **Time alignment.** TwelveData's datetimes are **exchange-local, not UTC** — the best
  alignment was at **+660 minutes (+11h)**. Anyone comparing the two without finding that
  offset would measure 83 pips of "error" and conclude the data was broken. It was not.

**What this means practically:** never mix two sources in one backtest. A 6-pip difference on
EURUSD is comparable to a whole strategy's edge — a test that looks profitable on one feed can
lose on the other, and the difference is data, not strategy.

## Others, measured

| Source | Result |
|---|---|
| FXCM `candledata.fxcorporate.com` | `404` on every path tried (m1, H1, D1) — the old free endpoint is gone |
| HistData | works, but the form's `tk` token is **empty in the HTML** and filled by JavaScript; needs a browser or manual download. Monthly M1 ASCII ZIP is fine by hand |
| AlphaVantage | 982 bars, but 25 requests/day |
| Stooq | daily only |
| Yahoo | 429 on both hosts all session |

## Recommendation

| Need | Use |
|---|---|
| **1-minute history for replay, 2005→now** | **Dukascopy**, one request per day |
| **Ticks with real spread** | Dukascopy hourly tick files (24 requests/day, slow) |
| An API with a key, deeper per-request | **TwelveData** free |
| Quick manual bulk | HistData monthly ZIP, downloaded by hand |
| Daily bars only | Stooq, or TwelveData |

For this app's replay mode, Dukascopy is the right primary: it is the only free source with
both real spread and 20 years of 1-minute bars, and a replay downloads history once, so the
503s and slow responses cost nothing at runtime.

Yahoo should be removed as the primary provider — it is rate-limited here and its spread is
synthetic.
