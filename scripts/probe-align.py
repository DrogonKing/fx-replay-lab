#!/usr/bin/env python3
"""Is the discrepancy real, or is my comparison misaligned? Find the offset that fits best."""
import calendar
import json
import lzma
import struct
import time
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def get(url, timeout=45, tries=10):
    # Dukascopy returns 503 in bursts; ten attempts with a 4s pause is what it actually takes.
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read(), r.status
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return e.read(100), 404
            time.sleep(4)
        except Exception:
            time.sleep(4)
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


day = duka_day("EURUSD", 2026, 9, 20)
url = ("https://api.twelvedata.com/time_series?symbol=EUR/USD&interval=1min"
       "&outputsize=5000&apikey=demo")
body, st = get(url)
values = json.loads(body).get("values", [])

base = calendar.timegm(time.strptime("2026-10-20 00:00:00", "%Y-%m-%d %H:%M:%S"))
td = {}
for v in values:
    t = calendar.timegm(time.strptime(v["datetime"], "%Y-%m-%d %H:%M:%S"))
    td[t - base] = (float(v["open"]), float(v["close"]), float(v["low"]), float(v["high"]))

print(f"duka minutes: {len(day)}, td minutes: {len(td)}")

# Try shifting the td series by N minutes and see which N lines them up.
print()
print("offset scan (shift td by N minutes, median |close diff| in pips):")
best = None
for shift in range(-240, 241, 5):
    diffs = []
    for off, (_o, c, _lo, _hi) in day.items():
        peer = td.get(off + shift)
        if peer:
            diffs.append(abs(c - peer[1]) * 1e5)
    if len(diffs) < 100:
        continue
    diffs.sort()
    med = diffs[len(diffs) // 2]
    if best is None or med < best[1]:
        best = (shift, med, len(diffs))
    if shift % 60 == 0:
        print(f"  shift {shift:+4} min: median {med:7.2f} pip over {len(diffs)} minutes")

print(f"\nbest shift: {best[0]:+d} min, median {best[1]:.2f} pip over {best[2]} minutes")

# refine around the best
print()
print("refine ±10 minutes:")
for shift in range(best[0] - 10, best[0] + 11):
    diffs = []
    for off, (_o, c, _lo, _hi) in day.items():
        peer = td.get(off + shift)
        if peer:
            diffs.append(abs(c - peer[1]) * 1e5)
    if len(diffs) < 100:
        continue
    diffs.sort()
    print(f"  shift {shift:+4}: median {diffs[len(diffs) // 2]:6.2f} pip  n={len(diffs)}")
