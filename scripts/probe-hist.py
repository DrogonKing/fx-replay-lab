#!/usr/bin/env python3
"""Historical candle sources: what downloads, how deep, and does the data agree?

The last part is the one that matters. "Low error" is not a claim a vendor page can make;
it is measured by fetching the same minute from two independent sources and comparing.
"""
import gzip
import io
import json
import lzma
import struct
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def get(url, timeout=60, headers=None):
    h = {"User-Agent": UA, "Accept": "*/*"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read(), r.status, int((time.time() - t0) * 1000)
    except urllib.error.HTTPError as e:
        return e.read(300), e.code, int((time.time() - t0) * 1000)
    except Exception as e:
        return f"{type(e).__name__}: {e}".encode(), None, int((time.time() - t0) * 1000)


print("=" * 78)
print("FXCM candledata — free, no key, weekly CSV per instrument")
print("=" * 78)
# FXCM publishes m1 / H1 / D1 per instrument per year-week
for url, label in [
    ("https://candledata.fxcorporate.com/m1/EURUSD/2024/1.csv.gz", "m1 EURUSD week 1 2024"),
    ("https://candledata.fxcorporate.com/H1/EURUSD/2024.csv.gz", "H1 EURUSD 2024"),
    ("https://candledata.fxcorporate.com/D1/EURUSD/2024.csv.gz", "D1 EURUSD 2024"),
]:
    body, st, ms = get(url)
    print(f"  {label:26} {st} {ms:>6}ms  {len(body)} bytes")
    if st == 200 and len(body) > 100:
        try:
            raw = gzip.decompress(body)
            lines = raw.decode("utf-8", "replace").splitlines()
            print(f"    rows: {len(lines) - 1}, header: {lines[0][:60]}")
            for ln in lines[1:3]:
                print(f"    {ln[:90]}")
        except Exception as e:
            print(f"    decode: {e}")

print()
print("=" * 78)
print("HISTDATA — find the real download mechanism")
print("=" * 78)
page = "https://www.histdata.com/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/eurusd/2024/1"
body, st, ms = get(page)
txt = body.decode("utf-8", "replace")
print(f"  page: {st} {ms}ms {len(txt)} chars")
import re

# look for every hidden input, and the form
for m in re.finditer(r'<input[^>]*type=["\']hidden["\'][^>]*>', txt, re.I):
    print(f"    hidden: {m.group(0)[:120]}")
for m in re.finditer(r'<form[^>]*>', txt, re.I):
    print(f"    form: {m.group(0)[:140]}")
m = re.search(r'id=["\']tk["\'][^>]*value=["\']([^"\']+)', txt)
print(f"  tk token: {m.group(1)[:30] if m else 'not found'}")
m2 = re.search(r'name=["\']tk["\'][^>]*value=["\']([^"\']+)', txt)
print(f"  tk by name: {m2.group(1)[:30] if m2 else 'not found'}")
# maybe the download link is a direct href
for m in re.finditer(r'href=["\']([^"\']*get\.php[^"\']*)', txt):
    print(f"    get.php link: {m.group(1)[:140]}")

print()
print("=" * 78)
print("TWELVEDATA — how deep does history go on the free key?")
print("=" * 78)
for interval, size in [("1min", 5000), ("5min", 5000), ("1h", 5000), ("1day", 5000)]:
    url = (f"https://api.twelvedata.com/time_series?symbol=EUR/USD&interval={interval}"
           f"&outputsize={size}&apikey=demo")
    body, st, ms = get(url)
    try:
        d = json.loads(body)
        if "values" in d:
            v = d["values"]
            print(f"  {interval:6} {st} {ms:>5}ms  {len(v)} bars  "
                  f"{v[-1]['datetime']} -> {v[0]['datetime']}")
        else:
            print(f"  {interval:6} {st}  {str(d.get('message', d))[:80]}")
    except Exception as e:
        print(f"  {interval:6} {st}  parse {e}: {body[:60]!r}")

print()
print("=" * 78)
print("DUKASCOPY — how far back? (probe a few years)")
print("=" * 78)


def duka_day(sym, y, m0, d, tries=5):
    """One day of 1-minute candles. Returns dict time->(o,c,l,h) or None."""
    url = f"https://datafeed.dukascopy.com/datafeed/{sym}/{y}/{m0:02d}/{d:02d}/BID_candles_min_1.bi5"
    for _ in range(tries):
        body, st, ms = get(url, timeout=45)
        if st == 200 and len(body) > 200:
            try:
                raw = lzma.decompress(body)
                out = {}
                for i in range(len(raw) // 24):
                    t, o, c, lo, hi, v = struct.unpack(">IIIIIf", raw[i * 24:i * 24 + 24])
                    if o > 0:
                        out[t] = (o / 1e5, c / 1e5, lo / 1e5, hi / 1e5)
                return out
            except Exception:
                return None
        time.sleep(3)
    return None


for year in [2024, 2020, 2015, 2010, 2005]:
    got = duka_day("EURUSD", year, 0, 2)
    if got:
        ks = sorted(got)
        print(f"  {year}-01-02: {len(got)} minutes, first +{ks[0]}s, last +{ks[-1]}s")
    else:
        print(f"  {year}-01-02: FAILED")
    time.sleep(1)
