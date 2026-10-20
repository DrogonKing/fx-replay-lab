import { describe, it, expect, vi } from "vitest";
import { Feed, MemoryCache, mergeCandles } from "../src/core/feed.js";
import { pickInterval, sanitizeCandles } from "../src/core/provider.js";
import { YahooProvider, resolveSymbol, YAHOO_ALIASES } from "../src/core/providers/yahoo.js";
import type { Candle } from "../src/core/types.js";
import type { DataProvider, HistoryOutcome } from "../src/core/provider.js";

function bars(n: number, start = 1_700_000_000, step = 60): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: start + i * step,
    open: 2000 + i, high: 2001 + i, low: 1999 + i, close: 2000.5 + i, volume: 10,
  }));
}

function fakeProvider(outcome: HistoryOutcome): DataProvider {
  return {
    id: "yahoo",
    label: "fake",
    supportedIntervals: () => [1, 5, 15, 60, 1440],
    listSymbols: async () => [],
    history: async () => outcome,
  };
}

describe("mergeCandles", () => {
  it("dedupes by time with the later value winning", () => {
    const a = bars(3);
    const b = [{ ...bars(1)[0]!, close: 9999 }, ...bars(2, 1_700_000_000 + 3 * 60)];
    const m = mergeCandles(a, b);
    expect(m).toHaveLength(5);
    expect(m[0]!.close).toBe(9999);
  });

  it("returns ascending order", () => {
    const m = mergeCandles(bars(3, 1_700_000_000 + 300), bars(3));
    expect(m.map((c) => c.time)).toEqual([...m.map((c) => c.time)].sort((x, y) => x - y));
  });
});

describe("sanitizeCandles", () => {
  it("drops impossible geometry and duplicates", () => {
    const good = bars(2);
    const bad: Candle[] = [
      { time: 5, open: 10, high: 5, low: 20, close: 10, volume: 0 }, // high<low
      { time: 6, open: 10, high: 10, low: 10, close: 20, volume: 0 }, // high<close
      { time: good[0]!.time, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 }, // dup
    ];
    const r = sanitizeCandles([...good, ...bad]);
    expect(r.dropped).toBe(2);
    expect(r.candles).toHaveLength(2);
    // duplicate kept the later definition
    expect(r.candles[0]!.open).toBe(1);
  });
});

describe("pickInterval", () => {
  it("prefers an exact match", () => {
    expect(pickInterval(60, [1, 5, 60])).toBe(60);
  });
  it("falls back to a divisor it can aggregate from", () => {
    expect(pickInterval(240, [1, 5, 15, 60])).toBe(60);
    expect(pickInterval(7, [1, 5])).toBe(1);
  });
  it("returns null when nothing works", () => {
    expect(pickInterval(3, [5, 15])).toBeNull();
  });
});

describe("Feed caching and degradation", () => {
  it("serves fresh cache without touching the network", async () => {
    const cache = new MemoryCache();
    cache.put({
      symbol: "GC=F", intervalMinutes: 5, candles: bars(10),
      fetchedAt: 1000,
    });
    const spy = vi.fn(async () => ({ ok: true as const, candles: bars(1), servedBy: "yahoo" as const, fromCache: false, notes: [] }));
    const feed = new Feed(
      { ...fakeProvider({ ok: false, code: "network", message: "x" }), history: spy },
      cache,
      () => 2000,
    );
    const r = await feed.load({ symbol: "GC=F", intervalMinutes: 5, cacheTtlMs: 60_000 });
    expect(spy).not.toHaveBeenCalled();
    expect(r.status.fromCache).toBe(true);
    expect(r.series.length).toBe(10);
  });

  it("fetches when the cache is stale and merges the result", async () => {
    const cache = new MemoryCache();
    cache.put({ symbol: "X", intervalMinutes: 5, candles: bars(2), fetchedAt: 0 });
    const feed = new Feed(
      fakeProvider({ ok: true, candles: bars(3, 1_700_000_000 + 2 * 60), servedBy: "yahoo", fromCache: false, notes: [] }),
      cache,
      () => 10_000_000,
    );
    const r = await feed.load({ symbol: "X", intervalMinutes: 5, cacheTtlMs: 1000 });
    expect(r.series.length).toBe(5); // 2 cached + 3 new, overlapping by 1? no: 2 then +2,3,4 min
    expect(r.status.state).toBe("live");
  });

  it("degrades to cache when the provider reports rate limiting", async () => {
    const cache = new MemoryCache();
    cache.put({ symbol: "X", intervalMinutes: 5, candles: bars(4), fetchedAt: 0 });
    const feed = new Feed(
      fakeProvider({ ok: false, code: "rate-limited", message: "429", retryAfterMs: 30000 }),
      cache,
      () => 1e9,
    );
    const r = await feed.load({ symbol: "X", intervalMinutes: 5, cacheTtlMs: 1 });
    expect(r.status.state).toBe("degraded");
    expect(r.status.usable).toBe(true);
    expect(r.status.message).toContain("rate limit");
    expect(r.series.length).toBe(4);
  });

  it("errors honestly when offline with no cache", async () => {
    const feed = new Feed(fakeProvider({ ok: false, code: "network", message: "down" }), new MemoryCache());
    const r = await feed.load({ symbol: "X", intervalMinutes: 5, offline: true });
    expect(r.status.state).toBe("error");
    expect(r.status.usable).toBe(false);
    expect(r.status.message).toMatch(/import a CSV/);
  });

  it("never throws when the provider itself throws", async () => {
    const p: DataProvider = {
      id: "yahoo", label: "boom", supportedIntervals: () => [1],
      listSymbols: async () => [],
      history: async () => { throw new Error("socket hang up"); },
    };
    const r = await new Feed(p, new MemoryCache()).load({ symbol: "X", intervalMinutes: 1 });
    expect(r.status.state).toBe("error");
    expect(r.status.message).toContain("socket hang up");
  });
});

describe("Feed.applyQuote", () => {
  it("appends a provisional bar without mutating the input", async () => {
    const cache = new MemoryCache();
    cache.put({ symbol: "X", intervalMinutes: 1, candles: bars(3), fetchedAt: 1e12 });
    const feed = new Feed(fakeProvider({ ok: false, code: "network", message: "" }), cache);
    const r = await feed.load({ symbol: "X", intervalMinutes: 1, cacheTtlMs: 1e15 });
    const before = r.series.length;
    const withQuote = feed.applyQuote(r.series, { time: 1_700_001_000, price: 9999 });
    expect(withQuote.length).toBe(before + 1);
    expect(r.series.length).toBe(before);
    expect(withQuote.close[before]).toBe(9999);
    expect(withQuote.high[before]).toBe(9999);
  });
});

describe("YahooProvider", () => {
  const okBody = {
    chart: {
      result: [{
        meta: { symbol: "GC=F", currency: "USD" },
        timestamp: [100, 160, 220],
        indicators: { quote: [{
          open: [1, 2, null],
          high: [2, 3, null],
          low: [0.5, 1.5, null],
          close: [1.5, 2.5, null],
          volume: [10, 20, null],
        }] },
      }],
      error: null,
    },
  };

  it("maps the parallel arrays into candles and skips null bars", async () => {
    const p = new YahooProvider(async () => ({ status: 200, body: okBody }));
    const r = await p.history({ symbol: "GC=F", intervalMinutes: 1, from: 0, to: 0 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.candles).toHaveLength(2);
      expect(r.candles[0]).toEqual({ time: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
    }
  });

  it("reports rate limiting with a retry hint", async () => {
    const p = new YahooProvider(async () => ({ status: 429, body: {}, retryAfterSeconds: 45 }));
    const r = await p.history({ symbol: "GC=F", intervalMinutes: 1, from: 0, to: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("rate-limited");
      expect(r.retryAfterMs).toBe(45_000);
    }
  });

  it("distinguishes a missing symbol from a data gap", async () => {
    const p = new YahooProvider(async () => ({ status: 404, body: {} }));
    const r = await p.history({ symbol: "NOPE", intervalMinutes: 1, from: 0, to: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not-found");
  });

  it("refuses an interval it cannot serve", async () => {
    const p = new YahooProvider(async () => ({ status: 200, body: okBody }));
    const r = await p.history({ symbol: "GC=F", intervalMinutes: 7, from: 0, to: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsupported");
  });

  it("reports a network throw as a network error, not a crash", async () => {
    const p = new YahooProvider(async () => { throw new Error("ENOTFOUND"); });
    const r = await p.history({ symbol: "GC=F", intervalMinutes: 1, from: 0, to: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("network");
  });

  it("refuses 4h instead of returning hourly data mislabelled as 4h", async () => {
    // Yahoo has no 240m interval. Returning 60m bars labelled 240m would corrupt
    // every aggregation and indicator built on them, so it must be an error.
    const p = new YahooProvider(async () => ({ status: 200, body: okBody }));
    const r = await p.history({ symbol: "GC=F", intervalMinutes: 240, from: 0, to: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsupported");
  });

  it("requests the native token for a supported interval", async () => {
    let calledUrl = "";
    const p = new YahooProvider(async (url) => {
      calledUrl = url;
      return { status: 200, body: okBody };
    });
    await p.history({ symbol: "GC=F", intervalMinutes: 60, from: 0, to: 0 });
    expect(calledUrl).toContain("interval=60m");
  });

  it("resolves the XAUUSD trap to gold futures", () => {
    expect(resolveSymbol("XAUUSD")).toBe("GC=F");
    expect(YAHOO_ALIASES["XAUUSD"]).toBe("GC=F");
    expect(resolveSymbol("EURUSD=X")).toBe("EURUSD=X");
  });
});
