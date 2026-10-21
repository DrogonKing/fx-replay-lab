#!/usr/bin/env python3
"""GBPUSD 2010-2016: which source actually delivers? Measured, per year."""
import lzma
import struct
import time
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def get(url, timeout=45, tries=12):
    """Dukascopy 503s in bursts; this is what it actually takes."""
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
            time.sleep(4)
        except Exception as e:
            last = type(e).__name__
            time.sleep(4)
    return b"", last


def duka_day(sym, y, m0, d):
    """One UTC day of 1-minute candles -> (count, first_o, last_c) or None."""
    url = (f"https://datafeed.dukascopy.com/datafeed/{sym}/{y}/{m0:02d}/{d:02d}"
           f"/BID_candles_min_1.bi5")
    body, st = get(url)
    if st != 200 or len(body) < 200:
        return None, st
    try:
        raw = lzma.decompress(body)
    except Exception:
        return None, "decode"
    n = 0
    first_o = last_c = None
    for i in range(len(raw) // 24):
        t, o, c, lo, hi, v = struct.unpack(">IIIIIf", raw[i * 24:i * 24 + 24])
        if o > 0:
            n += 1
            if first_o is None:
                first_o = o / 1e5
            last_c = c / 1e5
    return (n, first_o, last_c), st


print("=" * 78)
print("DUKASCOPY  GBPUSD  2010-2016  (sampling 2 days per year)")
print("=" * 78)
print("NOTE: month is ZERO-indexed in the URL. 2010/00/04 = 2010-01-04")
print()

# 4 Jan and 2 Sep of each year: one winter day, one autumn day, both weekdays
SAMPLES = [(0, 4), (8, 2)]
years = list(range(2010, 2017))
results = {}

for y in years:
    row = []
    for m0, d in SAMPLES:
        t0 = time.time()
        got, st = duka_day("GBPUSD", y, m0, d)
        ms = int((time.time() - t0) * 1000)
        if got:
            n, o, c = got
            row.append(f"{y}-{m0 + 1:02d}-{d:02d}: {n:4} min  O={o:.5f} C={c:.5f}  {ms:>6}ms")
            results.setdefault(y, []).append(n)
        else:
            row.append(f"{y}-{m0 + 1:02d}-{d:02d}: FAILED ({st})  {ms:>6}ms")
    for r in row:
        print(f"  {r}")
    time.sleep(1)

print()
print("  per-year summary:")
for y in years:
    ns = results.get(y, [])
    if ns:
        print(f"    {y}: {len(ns)}/2 days OK, minutes {min(ns)}-{max(ns)}")
    else:
        print(f"    {y}: nothing")

print()
print("=" * 78)
print("DUKASCOPY: full download cost for 2010-2016 GBPUSD")
print("=" * 78)
days = 0
for y in years:
    days += 366 if y % 4 == 0 else 365
print(f"  {len(years)} years = {days} day-files")
print(f"  at ~4s per file (with retries): {days * 4 / 3600:.1f} hours")
print(f"  at ~2s per file (good conditions): {days * 2 / 3600:.1f} hours")
print(f"  total size at ~11KB compressed/day: {days * 11 / 1024:.0f} MB")
print("  -> a one-time download, so slow is acceptable; must be resumable")
