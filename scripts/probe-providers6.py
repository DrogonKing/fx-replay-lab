#!/usr/bin/env python3
"""Sixth: the numbers that decide the recommendation."""
import json
import lzma
import struct
import time
import urllib.request
import urllib.error
import re

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def get(url, timeout=60, headers=None):
    h = {"User-Agent": UA, "Accept": "*/*"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read(), r.status
    except urllib.error.HTTPError as e:
        return e.read(400), e.code
    except Exception as e:
        return f"{type(e).__name__}: {e}".encode(), None


print("=" * 78)
print("DUKASCOPY: how RECENT is the data? (is there today?)")
print("=" * 78)
now = time.gmtime()
for days_back in [0, 1, 2, 3]:
    t = time.gmtime(time.time() - days_back * 86400)
    y, m, d = t.tm_year, t.tm_mon - 1, t.tm_mday  # dukascopy month is 0-indexed
    url = f"https://datafeed.dukascopy.com/datafeed/EURUSD/{y}/{m:02d}/{d:02d}/BID_candles_min_1.bi5"
    body, st = get(url)
    ok = st == 200 and len(body) > 200
    note = ""
    if ok:
        try:
            raw = lzma.decompress(body)
            n = len(raw) // 24
            t_last, o, c, lo, hi, v = struct.unpack(">IIIIIf", raw[(n - 1) * 24:n * 24])
            note = f"{n} candles, last +{t_last}s O={o / 1e5:.5f} C={c / 1e5:.5f}"
        except Exception as e:
            note = f"decode fail {e}"
    print(f"  {y}-{m + 1:02d}-{d:02d} (today-{days_back}): {st} {note or body[:50]!r}")

print()
print("=" * 78)
print("TWELVEDATA: the free plan's real numbers, from their own pricing JSON")
print("=" * 78)
body, st = get("https://api.twelvedata.com/api_usage?apikey=demo")
try:
    d = json.loads(body)
    print(f"  demo key usage: {json.dumps(d)}")
except Exception:
    print(f"  {body[:200]}")

# their plan page often exposes a JSON config
for u in ["https://twelvedata.com/pricing", "https://api.twelvedata.com/stocks?apikey=demo"]:
    body, st = get(u)
    txt = body.decode("utf-8", "replace")
    hits = re.findall(r"(\d[\d,]*)\s*(?:API\s*credits?|requests?)\s*(?:/\s*day|per day|daily)", txt, re.I)
    print(f"  {u.split('/')[-1]:22} {st}  day-limits found: {hits[:5]}")

print()
print("=" * 78)
print("OANDA: is a practice account really free, and what is the rate limit?")
print("=" * 78)
body, st = get("https://www.oanda.com/currency-converter/en/")
print(f"  oanda.com reachable: {st}")
# their developer portal documents the limits publicly
body, st = get("https://developer.oanda.com/rest-live-v20/introduction/")
txt = body.decode("utf-8", "replace")
print(f"  dev portal: {st}, {len(txt)} chars")
for kw in ["practice", "120 requests", "rate limit", "free"]:
    if kw.lower() in txt.lower():
        idx = txt.lower().find(kw.lower())
        print(f"  mentions '{kw}': ...{txt[max(0, idx - 60):idx + 90].strip()[:140]}...")

print()
print("=" * 78)
print("Which symbols does Dukascopy carry? (the full FX + metals list)")
print("=" * 78)
candidates = ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "XAGUSD", "AUDUSD",
              "USDCAD", "USDCHF", "NZDUSD", "EURJPY", "GBPJPY", "BTCUSD"]
for sym in candidates:
    url = f"https://datafeed.dukascopy.com/datafeed/{sym}/2024/00/02/BID_candles_min_1.bi5"
    body, st = get(url, timeout=45)
    ok = st == 200 and len(body) > 200
    extra = ""
    if ok:
        try:
            raw = lzma.decompress(body)
            n = len(raw) // 24
            t0, o, c, lo, hi, v = struct.unpack(">IIIIIf", raw[0:24])
            extra = f"{n} candles, first O={o / 1e5:.5f}"
        except Exception as e:
            extra = f"decode {e}"
    print(f"  {sym:8} {st}  {extra}")
