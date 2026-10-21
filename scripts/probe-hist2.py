#!/usr/bin/env python3
"""Dukascopy depth + a real cross-source accuracy comparison."""
import lzma
import struct
import time
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def get(url, timeout=45, tries=5):
    for attempt in range(tries):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read(), r.status
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return e.read(200), e.code
            time.sleep(3)
        except Exception:
            time.sleep(3)
    return b"", None


def duka_day(sym, y, m0, d):
    """{secondsOffset: (o, c, lo, hi)} for one UTC day, or None."""
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


print("DUKASCOPY depth (EURUSD, 1-minute):")
for year in [2024, 2020, 2016, 2012, 2008, 2005, 2003]:
    got = duka_day("EURUSD", year, 0, 2)
    if got:
        ks = sorted(got)
        print(f"  {year}: {len(got):4} minutes  first +{ks[0]:>5}s  last +{ks[-1]:>6}s")
    else:
        print(f"  {year}: no data")
    time.sleep(1)

print()
print("SYMBOL coverage on Dukascopy (2024-01-02):")
for sym in ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "XAGUSD", "AUDUSD",
            "USDCHF", "USDCAD", "NZDUSD", "EURJPY", "GBPJPY", "BTCUSD"]:
    got = duka_day(sym, 2024, 0, 2)
    if got:
        first = sorted(got)[0]
        o = got[first][0]
        print(f"  {sym:8} {len(got):4} minutes, first O={o:.5f}")
    else:
        print(f"  {sym:8} no data")
    time.sleep(1)

print()
print("=" * 78)
print("ACCURACY: Dukascopy vs TwelveData on the same 1-minute window")
print("=" * 78)
# Dukascopy: 2026-10-20 UTC day
day = duka_day("EURUSD", 2026, 9, 20)
if not day:
    print("  dukascopy day unavailable, skipping comparison")
else:
    base = 1792454400  # 2026-10-20T00:00:00Z
    print(f"  dukascopy: {len(day)} minutes for 2026-10-20")

    import json
    url = ("https://api.twelvedata.com/time_series?symbol=EUR/USD&interval=1min"
           "&outputsize=5000&apikey=demo")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    td = json.loads(urllib.request.urlopen(req, timeout=30).read())
    values = td.get("values", [])
    print(f"  twelvedata: {len(values)} bars, {values[-1]['datetime']} -> {values[0]['datetime']}")

    # compare on overlapping minutes
    import calendar
    compared = 0
    diffs = []
    for v in values:
        t = calendar.timegm(time.strptime(v["datetime"], "%Y-%m-%d %H:%M:%S"))
        off = t - base
        if off in day:
            d_o, d_c, d_lo, d_hi = day[off]
            t_c = float(v["close"])
            diffs.append(abs(d_c - t_c))
            compared += 1
            if compared <= 3:
                print(f"    {v['datetime']}  duka C={d_c:.5f}  td C={t_c:.5f}  diff={abs(d_c - t_c) * 1e5:.2f} pip")
    if diffs:
        diffs.sort()
        print(f"  compared {compared} overlapping minutes")
        print(f"  close diff: median {diffs[len(diffs) // 2] * 1e5:.2f} pip, "
              f"max {diffs[-1] * 1e5:.2f} pip")
