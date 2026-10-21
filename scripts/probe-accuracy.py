#!/usr/bin/env python3
"""Accuracy comparison only: Dukascopy vs TwelveData, 1-minute, same window."""
import calendar
import json
import lzma
import struct
import time
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def get(url, timeout=45, tries=6):
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read(), r.status
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return e.read(100), 404
            time.sleep(3)
        except Exception:
            time.sleep(3)
    return b"", None


def duka_day(sym, y, m0, d):
    url = f"https://datafeed.dukascopy.com/datafeed/{sym}/{y}/{m0:02d}/{d:02d}/BID_candles_min_1.bi5"
    body, st = get(url)
    if st != 200 or len(body) < 200:
        return None
    try:
        raw = lzma.decompress(body)
    except Exception:
        return None
    out = {}
    for i in range(len(raw) // 24):
        t, o, c, lo, hi, v = struct.unpack(">IIIIIf", raw[i * 24:i * 24 + 24])
        if o > 0:
            out[t] = (o / 1e5, c / 1e5, lo / 1e5, hi / 1e5)
    return out


print("Dukascopy 2026-10-20 (1-minute):")
day = duka_day("EURUSD", 2026, 9, 20)
if not day:
    print("  unavailable")
    raise SystemExit(1)
ks = sorted(day)
print(f"  {len(day)} minutes, offsets +{ks[0]}s .. +{ks[-1]}s")
print(f"  first O={day[ks[0]][0]:.5f} C={day[ks[0]][1]:.5f}")
print(f"  last  O={day[ks[-1]][0]:.5f} C={day[ks[-1]][1]:.5f}")

print()
print("TwelveData same day:")
url = ("https://api.twelvedata.com/time_series?symbol=EUR/USD&interval=1min"
       "&outputsize=5000&apikey=demo")
body, st = get(url)
td = json.loads(body)
values = td.get("values", [])
print(f"  {len(values)} bars, {values[-1]['datetime']} -> {values[0]['datetime']}")

base = calendar.timegm(time.strptime("2026-10-20 00:00:00", "%Y-%m-%d %H:%M:%S"))
compared = 0
close_diffs = []
high_diffs = []
low_diffs = []
examples = []
for v in values:
    t = calendar.timegm(time.strptime(v["datetime"], "%Y-%m-%d %H:%M:%S"))
    off = t - base
    if off in day:
        d_o, d_c, d_lo, d_hi = day[off]
        c = float(v["close"])
        h = float(v["high"])
        lo = float(v["low"])
        close_diffs.append(abs(d_c - c) * 1e5)
        high_diffs.append(abs(d_hi - h) * 1e5)
        low_diffs.append(abs(d_lo - lo) * 1e5)
        compared += 1
        if len(examples) < 4:
            examples.append((v["datetime"], d_c, c, abs(d_c - c) * 1e5,
                             d_hi, h, abs(d_hi - h) * 1e5))

print()
print(f"Overlapping minutes compared: {compared}")
for label, arr in [("close", close_diffs), ("high", high_diffs), ("low", low_diffs)]:
    arr.sort()
    n = len(arr)
    print(f"  {label:6} median {arr[n // 2]:.2f} pip   "
          f"p90 {arr[int(n * 0.9)]:.2f} pip   max {arr[-1]:.2f} pip")

print()
print("Sample rows (duka vs twelvedata):")
for dt, dc, tc, cd, dh, th, hd in examples:
    print(f"  {dt}  close {dc:.5f} vs {tc:.5f} ({cd:.2f}p)   high {dh:.5f} vs {th:.5f} ({hd:.2f}p)")
