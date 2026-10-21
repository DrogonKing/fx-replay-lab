#!/usr/bin/env python3
"""Which symbols does the free Dukascopy feed carry? Retries, because it 503s under load."""
import lzma
import struct
import time
import urllib.request
import urllib.error

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def get(url, timeout=45):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read(), r.status
    except urllib.error.HTTPError as e:
        return e.read(200), e.code
    except Exception as e:
        return str(e).encode(), None


SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "XAGUSD", "AUDUSD",
           "USDCAD", "USDCHF", "NZDUSD", "EURJPY", "GBPJPY", "BTCUSD", "ETHUSD"]

print("Dukascopy free feed, 2024-01-02, 1-minute candles:")
for sym in SYMBOLS:
    url = f"https://datafeed.dukascopy.com/datafeed/{sym}/2024/00/02/BID_candles_min_1.bi5"
    for attempt in range(4):
        body, st = get(url)
        if st == 200 and len(body) > 200:
            try:
                raw = lzma.decompress(body)
                n = len(raw) // 24
                t0, o, c, lo, hi, v = struct.unpack(">IIIIIf", raw[0:24])
                scale = 1e5 if o > 10000 else 1e5
                print(f"  {sym:8} OK  {n:5} candles   first O={o / scale:.5f}")
            except Exception as e:
                print(f"  {sym:8} OK but decode failed: {e}")
            break
        time.sleep(4)
    else:
        print(f"  {sym:8} {st} (gave up after retries)")
