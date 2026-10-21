#!/usr/bin/env python3
"""Two questions: (1) is the growing latency rate limiting? (2) does HistData deliver?

HistData is the realistic alternative for a bulk 2010-2016 pull: monthly ZIPs, no key.
"""
import lzma
import re
import struct
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import io

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def get(url, timeout=60, tries=1, headers=None):
    h = {"User-Agent": UA}
    if headers:
        h.update(headers)
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=h)
            t0 = time.time()
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read(), r.status, int((time.time() - t0) * 1000)
        except urllib.error.HTTPError as e:
            return e.read(300), e.code, 0
        except Exception as e:
            if attempt == tries - 1:
                return str(e).encode(), None, 0
            time.sleep(3)
    return b"", None, 0


print("=" * 78)
print("(1) Is Dukascopy rate-limiting me? Test a 2010 day NOW, after the burst")
print("=" * 78)
time.sleep(15)
for y, m0, d in [(2010, 0, 5), (2010, 0, 6), (2016, 8, 5)]:
    url = (f"https://datafeed.dukascopy.com/datafeed/GBPUSD/{y}/{m0:02d}/{d:02d}"
           f"/BID_candles_min_1.bi5")
    body, st, ms = get(url, timeout=60)
    ok = st == 200 and len(body) > 200
    n = "-"
    if ok:
        try:
            n = len(lzma.decompress(body)) // 24
        except Exception:
            n = "decode"
    print(f"  {y}-{m0 + 1:02d}-{d:02d}: {st} {ms:>6}ms  records={n}")
    time.sleep(6)

print()
print("=" * 78)
print("(2) HistData — the real download form for GBPUSD 2010-2016")
print("=" * 78)
page = ("https://www.histdata.com/download-free-forex-historical-data/"
        "?/ascii/1-minute-bar-quotes/gbpusd/2014/6")
body, st, ms = get(page)
txt = body.decode("utf-8", "replace")
print(f"  page: {st} {ms}ms {len(txt)} chars")

# the hidden fields, in order, are what get.php expects
fields = {}
for m in re.finditer(r'<input[^>]*type=["\']hidden["\'][^>]*>', txt, re.I):
    tag = m.group(0)
    name = re.search(r'name=["\']([^"\']+)', tag)
    value = re.search(r'value=["\']([^"\']*)', tag)
    if name:
        fields.setdefault(name.group(1), value.group(1) if value else "")
print(f"  hidden fields: {fields}")

# tk is filled by JS; check if the page's script reveals how
for m in re.finditer(r"tk[\"']?\s*[:=]\s*[\"']([^\"']{6,})", txt):
    print(f"  tk assignment: {m.group(1)[:40]}")
for m in re.finditer(r"<script[^>]*>(.{0,400}?tk.{0,400}?)</script>", txt, re.S | re.I):
    seg = re.sub(r"\s+", " ", m.group(1))
    print(f"  script mentions tk: {seg[:300]}")

# The actual mechanism: HistData uses a POST with a specific referer
if fields.get("fxpair"):
    data = urllib.parse.urlencode(fields).encode()
    print()
    print("  attempting POST with the page's own hidden fields...")
    req = urllib.request.Request(
        "https://www.histdata.com/get.php",
        data=data,
        headers={
            "User-Agent": UA,
            "Referer": page,
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": "https://www.histdata.com",
        },
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            blob = r.read()
            print(f"  POST: {r.status} {len(blob)} bytes in {int(time.time() - t0)}s "
                  f"type={r.headers.get('Content-Type')}")
            if blob[:2] == b"PK":
                z = zipfile.ZipFile(io.BytesIO(blob))
                for name in z.namelist()[:2]:
                    inner = z.read(name)
                    lines = inner.decode("utf-8", "replace").splitlines()
                    print(f"    {name}: {len(inner)} bytes, {len(lines) - 1} rows")
                    print(f"    header: {lines[0]}")
                    for ln in lines[1:3]:
                        print(f"    {ln}")
            else:
                print(f"    not a zip: {blob[:200]!r}")
    except Exception as e:
        print(f"  POST failed: {type(e).__name__}: {e}")

print()
print("=" * 78)
print("(3) HistData coverage: does GBPUSD exist back to 2010?")
print("=" * 78)
for year in [2010, 2012, 2014, 2016]:
    p = ("https://www.histdata.com/download-free-forex-historical-data/"
         f"?/ascii/1-minute-bar-quotes/gbpusd/{year}/1")
    b, s, m = get(p)
    t = b.decode("utf-8", "replace")
    # the page shows which months are available
    months = re.findall(r'/(\d{4})/(\d{1,2})"', t)
    has_form = 'name="fxpair"' in t
    print(f"  {year}: {s}  form={has_form}  month links={len(set(months))}  "
          f"{sorted(set(int(x[1]) for x in months if x[0] == str(year)))[:13]}")
    time.sleep(1)
