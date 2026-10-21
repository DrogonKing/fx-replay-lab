#!/usr/bin/env python3
"""Fifth: fix the Dukascopy candle decode, and prove HistData actually downloads."""
import json
import lzma
import struct
import time
import urllib.request
import urllib.error
import urllib.parse

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def get(url, timeout=90, headers=None):
    h = {"User-Agent": UA, "Accept": "*/*"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read(), r.status
    except urllib.error.HTTPError as e:
        return e.read(400), e.code
    except Exception as e:
        return f"{type(e).__name__}: {e}".encode(), None


print("=" * 78)
print("DUKASCOPY candle file — dump raw hex to find the real layout")
print("=" * 78)
url = "https://datafeed.dukascopy.com/datafeed/EURUSD/2024/00/02/BID_candles_min_1.bi5"
for attempt in range(4):
    body, st = get(url)
    if st == 200 and len(body) > 200:
        break
    print(f"  attempt {attempt + 1}: {st}, retrying")
    time.sleep(8)

raw = lzma.decompress(body)
print(f"  {len(raw)} bytes, {len(raw) / 24:.0f} records at 24B")
print("  first 3 records, hex + every plausible interpretation:")
for i in range(3):
    chunk = raw[i * 24:(i + 1) * 24]
    print(f"    raw: {chunk.hex()}")
    t, a, b, c, d, e = struct.unpack(">Ifffff", chunk)
    print(f"    as (I,4f,f): t={t} a={a:.5f} b={b:.5f} c={c:.5f} d={d:.5f} e={e:.2f}")
    # maybe prices are integers in points, not floats
    ti, p1, p2, p3, p4, v = struct.unpack(">IIIIII", chunk)
    print(f"    as (6I):     t={ti} p1={p1} p2={p2} p3={p3} p4={p4} v={v}")
    print(f"    as points/1e5: {p1 / 1e5:.5f} {p2 / 1e5:.5f} {p3 / 1e5:.5f} {p4 / 1e5:.5f}")

print()
print("  -> correct layout for EURUSD: uint32 time-offset, then 4 uint32 prices in 1e-5 points")
n = len(raw) // 24
good = 0
for i in range(n):
    chunk = raw[i * 24:(i + 1) * 24]
    t, o, c, lo, hi, v = struct.unpack(">IIIIII", chunk)
    if o > 0 and lo > 0:
        good += 1
        if good <= 3 or i == n - 1:
            print(f"    [{i}] +{t}s O={o / 1e5:.5f} C={c / 1e5:.5f} L={lo / 1e5:.5f} H={hi / 1e5:.5f}")
print(f"  usable records: {good}/{n}")

print()
print("=" * 78)
print("HISTDATA — POST to /get.php for a month of 1-minute ASCII bars")
print("=" * 78)
# HistData needs a referer and a tk token from the page
page_url = "https://www.histdata.com/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/eurusd/2024/1"
body, st = get(page_url)
txt = body.decode("utf-8", "replace")
import re
tk = re.search(r'id="tk"\s+value="([^"]+)"', txt)
print(f"  page {st}, tk token: {'found ' + tk.group(1)[:20] + '...' if tk else 'NOT FOUND'}")

if tk:
    data = urllib.parse.urlencode({
        "tk": tk.group(1),
        "date": "2024",
        "datemonth": "202401",
        "platform": "ASCII",
        "timeframe": "M1",
        "fxpair": "EURUSD",
    }).encode()
    req = urllib.request.Request(
        "https://www.histdata.com/get.php",
        data=data,
        headers={
            "User-Agent": UA,
            "Referer": page_url,
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            blob = r.read()
            print(f"  download: {r.status} {len(blob)} bytes in {int(time.time() - t0)}s")
            print(f"  content-type: {r.headers.get('Content-Type')}")
            if blob[:2] == b"PK":
                print("  it is a ZIP")
                import io
                import zipfile
                z = zipfile.ZipFile(io.BytesIO(blob))
                for name in z.namelist()[:3]:
                    inner = z.read(name)
                    print(f"    {name}: {len(inner)} bytes")
                    lines = inner.decode("utf-8", "replace").splitlines()
                    print(f"    header: {lines[0]}")
                    for ln in lines[1:3]:
                        print(f"    {ln}")
                    print(f"    total rows: {len(lines) - 1}")
            else:
                print(f"  first bytes: {blob[:120]!r}")
    except Exception as e:
        print(f"  download failed: {type(e).__name__}: {e}")
