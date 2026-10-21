#!/usr/bin/env python3
"""4 vs 8 workers only. Unbuffered, one line per config, so a timeout still reports."""
import concurrent.futures as cf
import lzma
import time
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def one(day):
    url = (f"https://datafeed.dukascopy.com/datafeed/GBPUSD/2013/01/{day:02d}"
           f"/BID_candles_min_1.bi5")
    t0 = time.time()
    for _ in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=45) as r:
                body = r.read()
            if len(body) < 200:
                continue
            return (day, True, int((time.time() - t0) * 1000))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return (day, False, 0)
        except Exception:
            pass
    return (day, False, int((time.time() - t0) * 1000))


for workers in (4, 8):
    days = list(range(2, 8))
    t0 = time.time()
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        results = list(ex.map(one, days))
    wall = time.time() - t0
    ok = sum(1 for r in results if r[1])
    rate = ok / wall if wall else 0
    print(f"{workers} workers: {ok}/{len(days)} in {wall:.1f}s "
          f"({rate:.3f} days/s) -> 2557 days = {2557 / rate / 60:.0f} min", flush=True)
