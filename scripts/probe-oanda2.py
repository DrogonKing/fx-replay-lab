#!/usr/bin/env python3
"""OANDA candles endpoint: the exact parameters, limits, and what a response looks like."""
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
    return re.sub(r"\s+", " ", t)


# find the right page for instruments/candles
for url in [
    "https://developer.oanda.com/rest-live-v20/instrument-ep/",
    "https://developer.oanda.com/rest-live-v20/instruments-ep/",
    "https://developer.oanda.com/rest-live-v20/pricing-ep/",
]:
    html, st = fetch(url)
    txt = plain(html)
    print(f"{url.split('/')[-2]:16} {st}  {len(txt)} chars")
    if st == 200 and "candles" in txt.lower():
        print("  -> has candle docs")
        # pull the key facts
        for kw in ["5000", "count query", "granularity query", "from query",
                   "to query", "complete", "M1", "S5", "H1", "D", "price query"]:
            for m in re.finditer(re.escape(kw), txt, re.I):
                s = txt[max(0, m.start() - 160):m.start() + 220]
                print(f"    [{kw}] ...{s.strip()[:330]}...")
                break
        # the granularity enum
        m = re.search(r"granularity\s+query[^.]{0,600}", txt, re.I)
        if m:
            print(f"\n  granularity detail: {m.group(0)[:500]}")
        break
    print()

print()
print("=" * 78)
print("Does a candle response include bid AND ask, or a mid?")
print("=" * 78)
html, st = fetch("https://developer.oanda.com/rest-live-v20/pricing-ep/")
txt = plain(html)
for kw in ["bid", "ask", "mid", "complete", "volume", "time"]:
    for m in re.finditer(kw, txt, re.I):
        s = txt[max(0, m.start() - 120):m.start() + 200]
        print(f"  [{kw}] ...{s.strip()[:300]}...")
        break

print()
print("=" * 78)
print("Streaming: how many instruments, and does it need a separate connection?")
print("=" * 78)
for kw in ["pricing/stream", "120 requests per second", "twice per second",
           "connection", "heartbeat", "disconnect"]:
    for m in re.finditer(kw, txt, re.I):
        s = txt[max(0, m.start() - 170):m.start() + 230]
        print(f"  [{kw}] ...{s.strip()[:350]}...")
        break
