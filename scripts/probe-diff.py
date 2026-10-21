#!/usr/bin/env python3
"""Precise cross-source diff. No shifting tricks: report the distribution honestly."""
import calendar
import json
import lzma
import struct
import statistics
import time
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def get(url, timeout=45, tries=12):
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read(), r.status
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return b"", 404
            time.sleep(4)
        except Exception:
            time.sleep(4)
    return b"", None


def duka_day(sym, y, m0, d):
    url = f"https://datafeed.dukascopy.com/datafeed/{sym}/{y}/{m0:02d}/{d:02d}/BID_candles_min_1.bi5"
    body, st = get(url)
    if st != 200 or len(body) < 200:
        return None
    raw = lzma.decompress(body)
    out = {}
    for i in range(len(raw) // 24):
        t, o, c, lo, hi, v = struct.unpack(">IIIIIf", raw[i * 24:i * 24 + 24])
        if o > 0:
            out[t] = {"o": o / 1e5, "c": c / 1e5, "lo": lo / 1e5, "hi": hi / 1e5}
    return out


day = duka_day("EURUSD", 2026, 9, 20)
if not day:
    raise SystemExit("dukascopy unavailable")

body, st = get("https://api.twelvedata.com/time_series?symbol=EUR/USD&interval=1min"
               "&outputsize=5000&apikey=demo")
vals = json.loads(body)["values"]

# TwelveData datetimes are exchange-local. Find the offset that maximises overlap AND
# minimises diff, rather than assuming UTC.
base = calendar.timegm(time.strptime("2026-10-20 00:00:00", "%Y-%m-%d %H:%M:%S"))
td_utc = {}
for v in vals:
    t = calendar.timegm(time.strptime(v["datetime"], "%Y-%m-%d %H:%M:%S"))
    td_utc[t - base] = {"c": float(v["close"]), "hi": float(v["high"]), "lo": float(v["low"])}

print(f"duka minutes {len(day)}   td minutes {len(td_utc)}")

# Timezone scan in 15-minute steps over a day either side
print("\ntimezone scan (td offset in minutes -> overlap, median close diff):")
rows = []
for shift_min in range(-720, 721, 15):
    shift = shift_min * 60
    diffs = []
    for off, d in day.items():
        peer = td_utc.get(off + shift)
        if peer:
            diffs.append(abs(d["c"] - peer["c"]) * 1e5)
    if len(diffs) >= 200:
        rows.append((shift_min, len(diffs), statistics.median(diffs)))

rows.sort(key=lambda r: r[2])
for shift_min, n, med in rows[:5]:
    print(f"  offset {shift_min:+5} min: n={n:5}  median {med:7.2f} pip")
print("  ...")
for shift_min, n, med in rows[-3:]:
    print(f"  offset {shift_min:+5} min: n={n:5}  median {med:7.2f} pip")

best_shift = rows[0][0] * 60
print(f"\nbest offset: {rows[0][0]:+d} min")

diffs = []
pairs = []
for off in sorted(day):
    d = day[off]
    peer = td_utc.get(off + best_shift)
    if peer:
        diffs.append(abs(d["c"] - peer["c"]) * 1e5)
        if len(pairs) < 6:
            pairs.append((off, d["c"], peer["c"], abs(d["c"] - peer["c"]) * 1e5))

diffs.sort()
n = len(diffs)
print(f"\nclose diff over {n} aligned minutes:")
print(f"  median {diffs[n // 2]:.2f} pip")
print(f"  p25    {diffs[n // 4]:.2f} pip")
print(f"  p75    {diffs[3 * n // 4]:.2f} pip")
print(f"  p95    {diffs[int(n * 0.95)]:.2f} pip")
print(f"  max    {diffs[-1]:.2f} pip")
print(f"  share within 1 pip: {sum(1 for x in diffs if x <= 1) / n * 100:.1f}%")
print(f"  share within 5 pip: {sum(1 for x in diffs if x <= 5) / n * 100:.1f}%")

print("\nsample rows:")
for off, dc, tc, dd in pairs:
    h = off // 3600
    m = (off % 3600) // 60
    print(f"  {h:02d}:{m:02d}  duka {dc:.5f}  td {tc:.5f}  diff {dd:.2f} pip")
