#!/usr/bin/env python3
"""What does OANDA's v20 API actually promise? Read their own docs, not memory."""
import re
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

PAGES = {
    "rate limits": "https://developer.oanda.com/rest-live-v20/best-practices/",
    "candles": "https://developer.oanda.com/rest-live-v20/instrument-ep/",
    "pricing stream": "https://developer.oanda.com/rest-live-v20/pricing-ep/",
    "intro": "https://developer.oanda.com/rest-live-v20/introduction/",
    "account": "https://developer.oanda.com/rest-live-v20/account-ep/",
}


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


for name, url in PAGES.items():
    html, st = fetch(url)
    txt = plain(html)
    print("=" * 78)
    print(f"{name}  [{st}]  {len(txt)} chars")
    print("=" * 78)

    if name == "rate limits":
        for kw in ["120", "requests per second", "rate limit", "concurrent",
                   "streaming", "burst"]:
            for m in re.finditer(kw, txt, re.I):
                s = txt[max(0, m.start() - 140):m.start() + 180]
                print(f"  [{kw}] ...{s.strip()[:280]}...")
                break

    elif name == "candles":
        for kw in ["5000", "count", "granularity", "maximum", "from", "to",
                   "complete", "M1", "S5", "history"]:
            for m in re.finditer(kw, txt, re.I):
                s = txt[max(0, m.start() - 130):m.start() + 170]
                print(f"  [{kw}] ...{s.strip()[:270]}...")
                break

    elif name == "pricing stream":
        for kw in ["stream", "tick", "heartbeat", "bid", "ask", "PRICE"]:
            for m in re.finditer(kw, txt, re.I):
                s = txt[max(0, m.start() - 130):m.start() + 170]
                print(f"  [{kw}] ...{s.strip()[:270]}...")
                break

    elif name == "intro":
        for kw in ["practice", "fxtrade", "token", "free", "demo", "sandbox"]:
            for m in re.finditer(kw, txt, re.I):
                s = txt[max(0, m.start() - 140):m.start() + 180]
                print(f"  [{kw}] ...{s.strip()[:280]}...")
                break
    print()
