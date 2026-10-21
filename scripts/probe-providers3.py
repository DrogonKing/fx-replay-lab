#!/usr/bin/env python3
"""Third round: bulk paths and real limits. What can actually back a whole chart."""
import json
import lzma
import struct
import time
import urllib.request
import urllib.error

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def get(url, timeout=90, headers=None):
    h = {"User-Agent": UA, "Accept": "*/*"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read(), r.status, int((time.time() - t0) * 1000)
    except urllib.error.HTTPError as e:
        return e.read(400), e.code, int((time.time() - t0) * 1000)
    except Exception as e:
        return f"{type(e).__name__}: {e}".encode(), None, int((time.time() - t0) * 1000)


print("=" * 78)
print("DUKASCOPY bulk: ONE file per day of minute candles, instead of 24 tick files")
print("=" * 78)
# BID_candles_min_1.bi5 = 1-minute candles for the whole day, one request
url = "https://datafeed.dukascopy.com/datafeed/EURUSD/2024/00/02/BID_candles_min_1.bi5"
body, st, ms = get(url)
print(f"status {st} {ms}ms  compressed {len(body)} bytes")
if st == 200 and len(body) > 100:
    try:
        raw = lzma.decompress(body)
        # 24 bytes per minute candle: uint32 time-offset(sec), 4x float32 open/close/low/high, float32 vol
        n = len(raw) // 24
        print(f"  decompressed {len(raw)} bytes = {n} minute candles")
        for i in (0, 1, n - 1):
            off = i * 24
            t, o, c, lo, hi, v = struct.unpack(">Ifffff", raw[off:off + 24])
            print(f"  candle {i}: +{t}s  O={o:.5f} C={c:.5f} L={lo:.5f} H={hi:.5f} V={v:.2f}")
    except Exception as e:
        print(f"  decode failed: {type(e).__name__}: {e}")
else:
    print(f"  body: {body[:150]}")

print()
print("  a full YEAR of 1-minute data = 365 requests (one per day):")
print("  at the ~28s/hour-file latency seen, one day-file should be ~1-3s")

print()
print("=" * 78)
print("DUKASCOPY: is a whole day of TICKS one file? (vs 24 hourly files)")
print("=" * 78)
url = "https://datafeed.dukascopy.com/datafeed/EURUSD/2024/00/02/00h_ticks.bi5"
t0 = time.time()
body, st, ms = get(url)
print(f"  one hour of ticks: {ms}ms, {len(body)} bytes -> {len(body) / max(ms, 1) * 1000:.0f} B/s")

print()
print("=" * 78)
print("TWELVEDATA: what do the free-tier docs actually promise?")
print("=" * 78)
body, st, ms = get("https://api.twelvedata.com/api_usage?apikey=demo")
print(f"  api_usage: status {st} {ms}ms  {body[:250].decode('utf-8', 'replace')}")

body, st, ms = get("https://twelvedata.com/pricing")
txt = body.decode("utf-8", "replace")
import re
for pat in [r"(\d+)\s*(?:API\s*)?credits?[^<]{0,40}", r"(\d+)\s*requests?[^<]{0,30}(?:per|/)\s*(?:day|minute|min)"]:
    found = re.findall(pat, txt, re.I)[:6]
    if found:
        print(f"  pricing mentions {pat[:20]}: {found}")

print()
print("=" * 78)
print("TWELVEDATA: does the demo key cover more than EUR/USD?")
print("=" * 78)
for sym in ["GBP/USD", "XAU/USD", "USD/JPY"]:
    body, st, ms = get(f"https://api.twelvedata.com/time_series?symbol={sym}&interval=5min&outputsize=2&apikey=demo")
    try:
        d = json.loads(body)
        msg = d.get("message") or ("values" in d and f"{len(d['values'])} bars")
    except Exception:
        msg = body[:80]
    print(f"  {sym:9} status {st}  {str(msg)[:90]}")

print()
print("=" * 78)
print("YAHOO with a browser-ish cookie + crumb: does the 429 lift?")
print("=" * 78)
# Yahoo often gates on a session cookie
body, st, ms = get("https://fc.yahoo.com", timeout=20)
cookie = ""
print(f"  fc.yahoo.com: status {st}")
body2, st2, ms2 = get(
    "https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=5m&range=1d",
    headers={"Accept": "application/json", "Referer": "https://finance.yahoo.com/"},
)
print(f"  chart with referer: status {st2} {ms2}ms  {body2[:100].decode('utf-8', 'replace')}")

print()
print("=" * 78)
print("STOOQ: 5-minute intraday exists? (the daily CSV worked)")
print("=" * 78)
for u, label in [
    ("https://stooq.com/q/d/l/?s=eurusd&i=5", "stooq 5m csv"),
    ("https://stooq.com/q/l/?s=eurusd&f=sd2t2ohlcv&h&e=csv", "stooq quote csv"),
    ("https://stooq.com/q/d/l/?s=eurusd&i=d", "stooq daily csv"),
]:
    body, st, ms = get(u)
    print(f"  {label:18} status {st} {ms}ms  {body[:80].decode('utf-8', 'replace')!r}")
