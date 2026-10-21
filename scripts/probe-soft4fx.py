#!/usr/bin/env python3
"""Where does Soft4FX get its data? Read their own site and docs."""
import re
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

PAGES = [
    "https://soft4fx.com/",
    "https://soft4fx.com/forex-simulator/",
    "https://soft4fx.com/forex-simulator-mt4/",
    "https://soft4fx.com/forex-simulator-mt5/",
    "https://soft4fx.com/faq/",
    "https://soft4fx.com/documentation/",
    "https://soft4fx.com/support/",
    "https://soft4fx.com/tick-data/",
    "https://soft4fx.com/historical-data/",
]


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


KEYWORDS = ["data", "tick", "MT4", "MT5", "Metatrader", "history", "import",
            "broker", "Dukascopy", "HistData", "CSV", "source", "feed",
            "M1", "timeframe", "download"]

for url in PAGES:
    html, st = fetch(url)
    if st != 200:
        print(f"{url:52} {st}")
        continue
    txt = plain(html)
    print("=" * 78)
    print(f"{url}  [{st}]  {len(txt)} chars")
    print("=" * 78)
    found = False
    for kw in KEYWORDS:
        for m in re.finditer(rf"\b{kw}\b", txt, re.I):
            s = txt[max(0, m.start() - 170):m.start() + 230]
            print(f"  [{kw}] ...{s.strip()[:360]}...")
            found = True
            break
    if not found:
        print(f"  (nothing relevant) first 200: {txt[:200]}")
    print()
