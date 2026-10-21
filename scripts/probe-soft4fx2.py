#!/usr/bin/env python3
"""Soft4FX details: data sources, instrument list, and how the download works."""
import re
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", "replace"), r.status
    except urllib.error.HTTPError as e:
        return e.read(300).decode("utf-8", "replace"), e.code
    except Exception as e:
        return f"{type(e).__name__}: {e}", None


def plain(html):
    t = re.sub(r"<script.*?</script>", " ", html, flags=re.S | re.I)
    t = re.sub(r"<style.*?</style>", " ", t, flags=re.S | re.I)
    t = re.sub(r"<[^>]+>", " ", t)
    t = re.sub(r"&nbsp;?", " ", t)
    t = re.sub(r"&amp;", "&", t)
    t = re.sub(r"&#8217;", "'", t)
    return re.sub(r"\s+", " ", t).strip()


html, st = fetch("https://soft4fx.com/")
txt = plain(html)
print(f"homepage [{st}] {len(txt)} chars")

print()
print("=" * 78)
print("The data paragraph, in full")
print("=" * 78)
i = txt.find("Good data is key")
if i >= 0:
    print("  " + txt[i:i + 700])

print()
print("=" * 78)
print("How the simulator works (the 4 steps they list)")
print("=" * 78)
i = txt.find("How Forex Simulator Works")
if i >= 0:
    print("  " + txt[i:i + 700])

print()
print("=" * 78)
print("Find every link on the site, to locate the instrument list page")
print("=" * 78)
links = sorted(set(re.findall(r'href="(https?://soft4fx\.com/[^"#]*)"', html)))
for ln in links:
    print(f"  {ln}")

print()
print("=" * 78)
print("Try the instrument list and pricing pages")
print("=" * 78)
for path in ["instruments", "instrument-list", "pricing", "download",
             "tutorials", "mt5-version", "mt4-version"]:
    u = f"https://soft4fx.com/{path}/"
    h, s = fetch(u)
    t = plain(h)
    print(f"  {u:46} {s}  {len(t)} chars")
    if s == 200:
        for kw in ["Dukascopy", "TrueFX", "HistData", "instruments", "pairs",
                   "price", "tick"]:
            j = t.find(kw)
            if j >= 0:
                print(f"      [{kw}] ...{t[max(0, j - 120):j + 200].strip()[:300]}...")
                break
