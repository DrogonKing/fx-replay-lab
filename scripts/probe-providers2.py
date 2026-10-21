#!/usr/bin/env python3
"""Second round: what does each working source ACTUALLY give, and at what limits."""
import json
import time
import urllib.request
import urllib.error

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def get(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read(), r.status, int((time.time() - t0) * 1000)
    except urllib.error.HTTPError as e:
        return e.read(600), e.code, int((time.time() - t0) * 1000)
    except Exception as e:
        return f"{type(e).__name__}: {e}".encode(), None, int((time.time() - t0) * 1000)


print("=" * 78)
print("TWELVEDATA free tier — how many bars, what interval, what latency")
print("=" * 78)
# demo key: EUR/USD only, but shows the response shape
body, st, ms = get("https://api.twelvedata.com/time_series?symbol=EUR/USD&interval=1min&outputsize=5000&apikey=demo")
print(f"status {st} {ms}ms  bytes {len(body)}")
try:
    d = json.loads(body)
    if "values" in d:
        print(f"  bars: {len(d['values'])}")
        print(f"  newest: {d['values'][0]}")
        print(f"  oldest: {d['values'][-1]}")
    else:
        print(f"  {json.dumps(d)[:300]}")
except Exception as e:
    print(f"  parse: {e}")

print()
print("=" * 78)
print("ALPHAVANTAGE free tier — 25 requests/DAY is the real limit")
print("=" * 78)
body, st, ms = get("https://www.alphavantage.co/query?function=FX_INTRADAY&from_symbol=EUR&to_symbol=USD&interval=5min&outputsize=full&apikey=demo")
print(f"status {st} {ms}ms  bytes {len(body)}")
try:
    d = json.loads(body)
    keys = list(d.keys())
    print(f"  top keys: {keys[:3]}")
    if "Information" in d:
        print(f"  LIMIT NOTE: {str(d['Information'])[:200]}")
    if "Note" in d:
        print(f"  NOTE: {str(d['Note'])[:200]}")
    ts = d.get("Time Series FX (5min)", {})
    if ts:
        ks = sorted(ts.keys())
        print(f"  bars: {len(ks)}  range: {ks[0]} -> {ks[-1]}")
        print(f"  sample: {ks[-1]} {ts[ks[-1]]}")
except Exception as e:
    print(f"  parse: {e}")

print()
print("=" * 78)
print("DUKASCOPY — real ticks, free, no key. Decode one hour properly.")
print("=" * 78)
import struct
import lzma

# EURUSD 2024-01-02 00h UTC
url = "https://datafeed.dukascopy.com/datafeed/EURUSD/2024/00/02/00h_ticks.bi5"
body, st, ms = get(url, timeout=60)
print(f"status {st} {ms}ms  compressed bytes {len(body)}")
try:
    raw = lzma.decompress(body)
    print(f"  decompressed {len(raw)} bytes = {len(raw) // 20} ticks (20 bytes each)")
    # each record: uint32 ms offset, uint32 ask, uint32 bid, float32 askVol, float32 bidVol
    for i in range(min(3, len(raw) // 20)):
        off = i * 20
        ms_off, ask, bid, av, bv = struct.unpack(">IIIff", raw[off:off + 20])
        # EURUSD point value is 1e-5
        print(f"  tick {i}: +{ms_off}ms  bid={bid / 1e5:.5f}  ask={ask / 1e5:.5f}  "
              f"spread={(ask - bid) / 1e5 * 1e4:.2f} pips")
    # count unique minutes in the hour
    minutes = set()
    for i in range(len(raw) // 20):
        off = i * 20
        ms_off = struct.unpack(">I", raw[off:off + 4])[0]
        minutes.add(ms_off // 60000)
    print(f"  minutes covered in this hour: {len(minutes)}/60")
except Exception as e:
    print(f"  decode failed: {type(e).__name__}: {e}")

print()
print("=" * 78)
print("YAHOO — is the 429 persistent or transient?")
print("=" * 78)
for attempt in range(3):
    body, st, ms = get("https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=5m&range=1d")
    print(f"  attempt {attempt + 1}: status {st} {ms}ms  {body[:80].decode('utf-8', 'replace')}")
    if st == 200:
        break
    time.sleep(4)

print()
print("  query2 host:")
body, st, ms = get("https://query2.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=5m&range=1d")
print(f"  status {st} {ms}ms  {body[:80].decode('utf-8', 'replace')}")
