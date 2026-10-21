# Free market data: what actually works

Every number below was measured from this host on 2026-10-21, not read from a marketing page.
The scripts that produced them are in `scripts/probe-providers*.py`.

## Verdict first

**OANDA practice is the best answer** for live FX paper trading — because it is a broker demo
account, not a data API. You get real bid/ask, real spread, real commission, and a real order
book to trade against. Everything else here is a charting feed.

**Dukascopy is the best free historical source** — genuine ticks and 1-minute candles, no key,
no account, decades of history. One request returns a whole day of 1-minute bars.

**Yahoo is currently broken from this host** and should not be the primary provider.

## Measured results

### Yahoo Finance — 429 on both hosts

```
query1.finance.yahoo.com  -> 429 Too Many Requests
query2.finance.yahoo.com  -> 429 Too Many Requests
```

Persistent across retries and after a 20-second pause, and it has been for the whole session.
It also has no real bid/ask (only a synthetic spread), so it was never a good fit for paper
trading — it was simply the one that needed no account.

**Consequence for this app:** the live mode currently polls Yahoo. It will show
`Too Many Requests` until a real provider is wired in.

### Dukascopy — free, no key, real ticks

```
EURUSD 2024-01-02 00h ticks:  1432 ticks, 60/60 minutes covered
  bid=1.10366 ask=1.10370 spread=0.40 pips
  bid=1.10366 ask=1.10371 spread=0.50 pips
```

A **real spread**, varying tick to tick — the thing a synthetic feed cannot give you.

1-minute candles for a whole day in **one request**:

```
EURUSD/2024/00/02/BID_candles_min_1.bi5
  11714 bytes -> 34560 bytes -> 1440 records
  [0]    +0s     O=1.10366 C=1.10374 L=1.10366 H=1.10376
  [1]    +60s    O=1.10371 C=1.10375 L=1.10368 H=1.10375
  [1439] +86340s O=1.09411 C=1.09416 L=1.09411 H=1.09419
  usable records: 1440/1440
```

**The decode layout matters** and is not documented clearly: each 24-byte record is
`uint32 timeOffsetSeconds` followed by **four uint32 prices in 1e-5 points**
(open, close, low, high — note the order), then a float32 volume. Reading the prices as float32
gives all zeros, which looks like corrupt data rather than a wrong layout.

**Recency:** yesterday's file was complete (1440 candles, last at +86340s). Today's file
timed out — the feed is populated with a lag and is slow while a day is still open.

**Reliability is the catch:** the server returns `503` under load and single requests took
between 1 and 60 seconds in these probes. A fetcher needs retries and must not assume a fixed
latency. It is fine for historical loading; it is not a real-time tick stream.

### TwelveData — the best free API with a key

The demo key returned **5000 real 1-minute EUR/USD bars in one request**:

```
5000 bars, 2026-10-18 00:44 -> 2026-10-21 12:03
newest: O=1.12274 H=1.1228 L=1.12269 C=1.1227
```

Free tier from their own pricing metadata: **8 requests/minute, 800 credits/day**, 1 credit per
time-series request. That is roughly 800 bars-refreshes a day — plenty for a chart polling
every 15 seconds while you are at the screen, and enough for a week of 1-minute history.

Forex is included on the free plan. The demo key itself only covers a few symbols
(`EUR/USD` and `USD/JPY` answered, `GBP/USD` and `XAU/USD` returned 401) — a real free key
covers the normal FX pairs.

### AlphaVantage — 25 requests/day, so no

982 bars came back in one request, but the free tier allows **25 requests per day**. That is
one chart load. Unusable for live, tolerable for a daily-only history pull.

### Others, and why not

| Source | Result |
|---|---|
| Binance | `451` — geo-blocked from this host |
| Stooq | serves daily only; the 5-minute URL returns HTML, not CSV |
| Finnhub / FMP / Polygon | `401` on the demo token — needs a real key |
| exchangerate.host | `101 missing_access_key` — no longer free |
| freeforexapi.com | timeout |
| api.forex.com | does not resolve |
| forex.com | `403` Cloudflare |
| HistData | works, but the download needs a per-session token scraped from the page; manual download is fine |

## Recommendation, per use

| Need | Use |
|---|---|
| **Live paper trading with a real spread** | **OANDA practice** (broker demo, free) |
| Free historical ticks + 1m candles | **Dukascopy** |
| Free live charting with a key | **TwelveData** free (8 req/min) |
| Daily bars only | Stooq, or AlphaVantage if you want an API |
| No account at all | Dukascopy for history; nothing good for live |

### Why OANDA and not "an API"

The question was "where is there a free API like OANDA and forex.com". The honest answer is
that OANDA and forex.com are **brokers**, and what they give away free is a *practice account*,
not a data API. That is strictly better for this app:

- real bid/ask from a real liquidity provider
- the actual spread and commission you would pay
- an order book your fills go into, instead of a simulation
- the same REST API in practice and live, so the adapter is written once

The catch is an account and a token, and Iranian residency is a practical obstacle for both
OANDA and forex.com. That is a real constraint, not a technical one, and it is why the free
no-account sources above still matter.

## What this means for the app

`src/main/net.ts` has a hard allowlist of four hosts (two Yahoo, two Stooq). Any of the above
needs that list extended, and each provider needs its own adapter:

1. **Dukascopy** — a historical loader: day-file per symbol, LZMA + 24-byte records, retries
   with backoff. Best value for the replay mode, which is what this app is mainly for.
2. **OANDA practice** — the live mode and eventually real order routing. Needs an account.
3. **TwelveData** — the middle option: a key but no broker, 8 req/min is enough for one chart.

Yahoo should be demoted to a fallback, or removed: it is rate-limited here and its spread is
synthetic, which makes it the worst possible choice for a paper-trading app.
