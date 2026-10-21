#!/usr/bin/env python3
"""Parallel throughput, printed unbuffered so a timeout still shows progress."""
import concurrent.futures as cf
import lzma
import sys
import time
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def one(day):
    url = (f"https://datafeed.dukascopy.com/datafeed/GBPUSD/2013/00/{day:02d}"
           f"/BID_candles_min_1.bi5")
    t0 = time.time()
    for _ in range(6):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read()
            if len(body) < 200:
                time.sleep(1)
                continue
            raw = lzma.decompress(body)
            return (day, True, int((time.time() - t0) * 1000), len(raw) // 24)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return (day, False, 0, 0)
            time.sleep(1)
        except Exception:
            time.sleep(1)
    return (day, False, int((time.time() - t0) * 1000), 0)


for workers in (1, 4, 8):
    days = list(range(2, 10))
    t0 = time.time()
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        results = list(ex.map(one, days))
    wall = time.time() - t0
    ok = sum(1 for r in results if r[1])
    rate = ok / wall if wall > 0 else 0
    eta = 2557 / rate / 60 if rate > 0 else 0
    print(f"{workers} workers: {ok}/{len(days)} days in {wall:5.1f}s  "
          f"({rate:.3f} days/s)  -> 2557 days = {eta:.0f} min", flush=True)
    time.sleep(3)
