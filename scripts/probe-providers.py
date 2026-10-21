#!/usr/bin/env python3
"""Probe free FX data endpoints from this host. Prints what actually answered."""
import json
import time
import urllib.request
import urllib.error

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def get(url, headers=None, timeout=15):
    h = {"User-Agent": UA, "Accept": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(4000)
            return {"ok": True, "status": r.status, "ms": int((time.time() - t0) * 1000),
                    "body": body.decode("utf-8", "replace")}
    except urllib.error.HTTPError as e:
        return {"ok": False, "status": e.code, "ms": int((time.time() - t0) * 1000),
                "body": e.read(400).decode("utf-8", "replace")}
    except Exception as e:
        return {"ok": False, "status": None, "ms": int((time.time() - t0) * 1000),
                "body": f"{type(e).__name__}: {e}"}


TESTS = [
    # --- no key required ---
    ("yahoo EURUSD 5m", "https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=5m&range=1d"),
    ("yahoo GC=F 5m", "https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=5m&range=1d"),
    ("stooq eurusd daily", "https://stooq.com/q/d/l/?s=eurusd&i=d"),
    ("stooq eurusd 5m", "https://stooq.com/q/l/?s=eurusd&i=5"),
    ("binance BTCUSDT 5m", "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=3"),
    ("dukascopy tick file", "https://datafeed.dukascopy.com/datafeed/EURUSD/2024/00/02/00h_ticks.bi5"),
    # --- free tier with key (demo keys) ---
    ("twelvedata demo", "https://api.twelvedata.com/time_series?symbol=EUR/USD&interval=5min&outputsize=3&apikey=demo"),
    ("alphavantage demo", "https://www.alphavantage.co/query?function=FX_INTRADAY&from_symbol=EUR&to_symbol=USD&interval=5min&apikey=demo"),
    ("finnhub forex", "https://finnhub.io/api/v1/forex/candle?symbol=OANDA:EUR_USD&resolution=5&count=3&token=demo"),
    ("fmp demo", "https://financialmodelingprep.com/api/v3/historical-chart/5min/EURUSD?apikey=demo"),
    ("polygon forex", "https://api.polygon.io/v2/aggs/ticker/C:EURUSD/range/5/minute/2024-01-02/2024-01-03?apiKey=demo"),
    # --- oanda public (no auth) ---
    ("oanda instruments", "https://api-fxpractice.oanda.com/v3/instruments"),
    ("oanda candles no auth", "https://api-fxpractice.oanda.com/v3/instruments/EUR_USD/candles?granularity=M5&count=3"),
    # --- others ---
    ("fxempire/fxdd feed", "https://www.freeforexapi.com/api/live?pairs=EURUSD"),
    ("exchangerate.host", "https://api.exchangerate.host/latest?base=EUR&symbols=USD"),
    ("er-api", "https://open.er-api.com/v6/latest/EUR"),
    ("histdata page", "https://www.histdata.com/download-free-forex-historical-data/"),
]

for name, url in TESTS:
    r = get(url)
    snippet = r["body"][:110].replace("\n", " ")
    print(f"{'OK ' if r['ok'] else 'FAIL'} {r['status'] or '---':>4} {r['ms']:>5}ms  {name:28} {snippet}")
