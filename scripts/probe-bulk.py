#!/usr/bin/env python3
"""Bulk reality check: real throughput over consecutive days, plus TwelveData depth."""
import lzma
import struct
import time
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def get(url, timeout=90, tries=8):
    last = None
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read(), r.status
        except urllib.error.HTTPError as e:
            last = e.code
            if e.code == 404:
                return b"", 404
            time.sleep(3)
        except Exception as e:
            last = type(e).__name__
            time.sleep(3)
    return b"", last


print("=" * 78)
print("DUKASCOPY real throughput: 10 CONSECUTIVE days, GBPUSD 2014-06")
print("=" * 78)
times = []
ok = 0
fail = 0
total_bytes = 0
total_minutes = 0

for d in range(2, 12):
    url = (f"https://datafeed.dukascopy.com/datafeed/GBPUSD/2014/05/{d:02d}"
           f"/BID_candles_min_1.bi5")
    t0 = time.time()
    body, st = get(url)
    ms = int((time.time() - t0) * 1000)
    if st == 200 and len(body) > 200:
        try:
            raw = lzma.decompress(body)
            n = len(raw) // 24
            times.append(ms)
            ok += 1
            total_bytes += len(body)
            total_minutes += n
            print(f"  2014-06-{d:02d}: OK   {ms:>6}ms  {len(body):>6}B  {n:4} min")
        except Exception as e:
            fail += 1
            print(f"  2014-06-{d:02d}: decode failed {e}")
    else:
        fail += 1
        print(f"  2014-06-{d:02d}: FAILED ({st}) {ms}ms")
    time.sleep(1)

print()
print(f"  {ok} ok, {fail} failed, {total_minutes} minutes, {total_bytes / 1024:.0f} KB compressed")
if times:
    times.sort()
    print(f"  latency: min {times[0]}ms  median {times[len(times) // 2]}ms  max {times[-1]}ms")
    print(f"  total wall time: {sum(times) / 1000:.1f}s for {ok} days")
    print(f"  -> 2557 days (2010-2016) would take "
          f"{2557 * (sum(times) / len(times)) / 1000 / 60:.0f} minutes "
          f"at this median, single-threaded")
    print(f"  -> with 4 parallel workers: "
          f"{2557 * (sum(times) / len(times)) / 1000 / 60 / 4:.0f} minutes")

print()
print("=" * 78)
print("TWELVEDATA: how far back does GBP/USD actually go per interval?")
print("=" * 78)
import json

for interval, size in [("1min", 5000), ("5min", 5000), ("1h", 5000), ("1day", 5000)]:
    url = (f"https://api.twelvedata.com/time_series?symbol=GBP/USD&interval={interval}"
           f"&outputsize={size}&apikey=demo")
    body, st = get(url, timeout=30, tries=2)
    try:
        d = json.loads(body)
        if "values" in d:
            v = d["values"]
            print(f"  {interval:6} {len(v):5} bars   {v[-1]['datetime']} -> {v[0]['datetime']}")
        else:
            print(f"  {interval:6} {str(d.get('message', d))[:100]}")
    except Exception:
        print(f"  {interval:6} {body[:100]!r}")

print()
print("  => 1min x 5000 bars covers only ~3.5 days, so TwelveData CANNOT deliver 2010-2016")
print("     at 1-minute. Daily goes back to 2007, hourly ~7 months.")
