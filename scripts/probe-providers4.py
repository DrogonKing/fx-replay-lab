#!/usr/bin/env python3
"""Fourth round: retry the flaky ones, and test the account-based providers properly."""
import json
import lzma
import struct
import time
import urllib.request
import urllib.error

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def get(url, timeout=60, headers=None):
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
print("DUKASCOPY retry — the day-candle bulk path (1 request = 1440 minutes)")
print("=" * 78)
paths = [
    ("BID_candles_min_1.bi5", "1-min candles, whole day"),
    ("BID_candles_hour_1.bi5", "1-hour candles, whole day"),
    ("00h_ticks.bi5", "ticks, one hour"),
]
for path, label in paths:
    url = f"https://datafeed.dukascopy.com/datafeed/EURUSD/2024/00/02/{path}"
    ok = False
    for attempt in range(3):
        body, st, ms = get(url)
        if st == 200 and len(body) > 200:
            ok = True
            try:
                raw = lzma.decompress(body)
                rec = {"min_1": 24, "hour_1": 24}.get("min_1" if "min" in path else "hour_1", 24)
                n = len(raw) // 24
                print(f"  {label:26} OK {ms}ms {len(body)}B -> {len(raw)}B = {n} records")
                if "min" in path:
                    for i in (0, n // 2, n - 1):
                        off = i * 24
                        t, o, c, lo, hi, v = struct.unpack(">Ifffff", raw[off:off + 24])
                        print(f"      [{i}] +{t}s O={o:.5f} C={c:.5f} L={lo:.5f} H={hi:.5f}")
            except Exception as e:
                print(f"  {label:26} OK but decode failed: {e}")
            break
        else:
            print(f"  {label:26} attempt {attempt + 1}: {st} {ms}ms {body[:60]!r}")
            time.sleep(6)
    if not ok:
        print(f"  {label:26} FAILED after retries")

print()
print("=" * 78)
print("HISTDATA — free historical, downloadable, no key (what formats?)")
print("=" * 78)
body, st, ms = get("https://www.histdata.com/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/eurusd/2024/1")
txt = body.decode("utf-8", "replace")
print(f"  page: status {st} {ms}ms  {len(txt)} chars")
import re
# the download form posts to a specific URL
m = re.search(r'action="([^"]*)"', txt)
print(f"  form action: {m.group(1) if m else 'none'}")
for kw in ["1-minute", "ASCII", "MetaTrader", "tick", "download"]:
    if kw.lower() in txt.lower():
        print(f"  mentions {kw}")

print()
print("=" * 78)
print("OANDA — what exactly does a free practice account give?")
print("=" * 78)
for u, label in [
    ("https://api-fxpractice.oanda.com/v3/accounts", "practice accounts"),
    ("https://api-fxtrade.oanda.com/v3/accounts", "live accounts"),
    ("https://www.oanda.com/currency-converter/", "public converter"),
]:
    body, st, ms = get(u, timeout=20)
    print(f"  {label:20} {st} {ms}ms  {body[:90].decode('utf-8', 'replace')!r}")

print()
print("=" * 78)
print("FOREX.COM — is there any public API?")
print("=" * 78)
for u, label in [
    ("https://api.forex.com/", "api.forex.com"),
    ("https://www.forex.com/en/market-analysis/latest-research/", "research page"),
]:
    body, st, ms = get(u, timeout=20)
    print(f"  {label:22} {st} {ms}ms  {body[:90].decode('utf-8', 'replace')!r}")

print()
print("=" * 78)
print("YAHOO — one more try after a pause, both hosts, with a cookie jar")
print("=" * 78)
time.sleep(20)
for host in ["query1", "query2"]:
    body, st, ms = get(f"https://{host}.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=5m&range=1d")
    print(f"  {host}: {st} {ms}ms  {body[:70].decode('utf-8', 'replace')!r}")
