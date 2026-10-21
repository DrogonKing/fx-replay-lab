#!/usr/bin/env python3
"""OANDA: granularity list, price components, and account requirements. Read the schemas."""
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
    t = re.sub(r"&#34;", '"', t)
    t = re.sub(r"&nbsp;?", " ", t)
    return re.sub(r"\s+", " ", t)


html, st = fetch("https://developer.oanda.com/rest-live-v20/pricing-ep/")
txt = plain(html)
print(f"pricing page {st}, {len(txt)} chars")

print()
print("--- CandlestickGranularity enum ---")
m = re.search(r"CandlestickGranularity[^A-Z]{0,80}((?:S5|M1|M2|M3|M4|M5)[^\]]{0,900})", txt)
if m:
    print(f"  {m.group(0)[:900]}")

print()
print("--- PricingComponent (bid / ask / mid) ---")
for m in re.finditer(r"PricingComponent[^.]{0,300}", txt):
    print(f"  {m.group(0)[:300]}")
    break
for kw in ['"bids"', '"asks"', '"bid"', '"ask"', '"closeoutBid"']:
    for m in re.finditer(re.escape(kw), txt):
        s = txt[max(0, m.start() - 200):m.start() + 260]
        print(f"  [{kw}] ...{s.strip()[:380]}...")
        break

print()
print("--- candle response fields ---")
m = re.search(r"Get candles for an Instrument.{0,2500}", txt)
if m:
    seg = m.group(0)
    for kw in ['"complete"', '"volume"', '"time"', '"mid"', '"bid"', '"ask"']:
        idx = seg.find(kw)
        if idx >= 0:
            print(f"  [{kw}] ...{seg[max(0, idx - 150):idx + 220].strip()[:330]}...")

print()
print("--- granularity: does OANDA have S5/M1 and what is the deepest? ---")
for kw in ["S5", "M1", "M5", "H1", "H4", "D", "W", "M"]:
    hits = len(re.findall(rf"\b{kw}\b", txt))
    print(f"  {kw:3} mentioned {hits} times")

print()
print("=" * 78)
print("Account requirement: does a demo give a REST token?")
print("=" * 78)
html, st = fetch("https://developer.oanda.com/rest-live-v20/introduction/")
txt = plain(html)
for kw in ["fxTrade", "practice", "demo account", "Manage API Access", "token"]:
    for m in re.finditer(kw, txt, re.I):
        s = txt[max(0, m.start() - 200):m.start() + 260]
        print(f"  [{kw}] ...{s.strip()[:380]}...")
        break

print()
print("=" * 78)
print("Is the practice host different? (api-fxpractice vs api-fxtrade)")
print("=" * 78)
for kw in ["api-fxpractice", "api-fxtrade", "stream-fxpractice", "stream-fxtrade"]:
    hits = re.findall(kw, txt)
    print(f"  {kw:20} {len(hits)} mentions")
