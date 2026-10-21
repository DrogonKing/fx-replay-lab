import { describe, it, expect } from "vitest";
import {
  ADAPTERS, MT5_ADAPTER, OANDA_ADAPTER, CTRADER_ADAPTER,
  OANDA_GRANULARITY, oandaHost, oandaInstrument, oandaCandlesUrl,
  parseOandaCandles, validateBridgeResponse, describeTransport,
} from "../src/core/brokers.js";

describe("adapters", () => {
  it("exposes three transports so no broker is hardcoded", () => {
    const ids = ADAPTERS.map((a) => a.id);
    expect(ids).toContain("mt5");
    expect(ids).toContain("oanda");
    expect(ids).toContain("ctrader");
  });

  it("marks MT5 as terminal-bridge and Windows-only, because it has no HTTP API", () => {
    expect(MT5_ADAPTER.transport).toBe("terminal-bridge");
    expect(MT5_ADAPTER.windowsOnly).toBe(true);
  });

  it("marks OANDA as plain REST", () => {
    expect(OANDA_ADAPTER.transport).toBe("rest");
    expect(OANDA_ADAPTER.windowsOnly).toBe(false);
  });

  it("works with ANY broker through MT5, not one name", () => {
    // the whole point of the bridge: the broker list is not ours to decide
    expect(MT5_ADAPTER.label).toContain("any broker");
    expect(MT5_ADAPTER.credentials.map((c) => c.key)).toContain("server");
  });

  it("flags secrets so they are never persisted", () => {
    expect(MT5_ADAPTER.credentials.find((c) => c.key === "password")?.secret).toBe(true);
    expect(OANDA_ADAPTER.credentials.find((c) => c.key === "token")?.secret).toBe(true);
    expect(CTRADER_ADAPTER.credentials.find((c) => c.key === "clientSecret")?.secret).toBe(true);
  });
});

describe("oandaHost", () => {
  it("switches host for practice", () => {
    expect(oandaHost(true)).toBe("api-fxpractice.oanda.com");
    expect(oandaHost(false)).toBe("api-fxtrade.oanda.com");
  });
});

describe("oandaInstrument", () => {
  it("uses underscores, which is OANDA's naming", () => {
    expect(oandaInstrument("EURUSD")).toBe("EUR_USD");
    expect(oandaInstrument("GBPUSD")).toBe("GBP_USD");
  });

  it("handles a suffixed symbol", () => {
    expect(oandaInstrument("EURUSD=X")).toBe("EUR_USD");
    expect(oandaInstrument("eur/usd")).toBe("EUR_USD");
  });

  it("handles metals", () => {
    expect(oandaInstrument("XAUUSD")).toBe("XAU_USD");
  });

  it("STRIPS Yahoo's =X suffix before splitting", () => {
    // this used to yield "EURUSDX", which matched no rule and 404'd at the API
    expect(oandaInstrument("EURUSD=X")).toBe("EUR_USD");
  });

  it("handles crypto crosses, which are also 6 characters", () => {
    expect(oandaInstrument("BTCUSD")).toBe("BTC_USD");
    expect(oandaInstrument("ETHUSD")).toBe("ETH_USD");
  });
});

describe("OANDA_GRANULARITY", () => {
  it("uses OANDA's own names, not minutes", () => {
    expect(OANDA_GRANULARITY[1]).toBe("M1");
    expect(OANDA_GRANULARITY[60]).toBe("H1");
    expect(OANDA_GRANULARITY[1440]).toBe("D");
  });

  it("has no entry for an interval OANDA does not serve", () => {
    expect(OANDA_GRANULARITY[7]).toBeUndefined();
  });
});

describe("oandaCandlesUrl", () => {
  const base = {
    symbol: "EURUSD", intervalMinutes: 5,
    from: Date.UTC(2024, 0, 2) / 1000, to: Date.UTC(2024, 0, 3) / 1000,
    price: "bid" as const, practice: true,
  };

  it("builds a practice URL with the instrument underscored", () => {
    const u = oandaCandlesUrl("101-004-1-001", base);
    expect(u).toContain("api-fxpractice.oanda.com");
    expect(u).toContain("/v3/accounts/101-004-1-001/instruments/EUR_USD/candles");
  });

  it("sends the price component, which is why OANDA beats a mid-only feed", () => {
    expect(oandaCandlesUrl("a", base)).toContain("price=bid");
    expect(oandaCandlesUrl("a", { ...base, price: "ask" })).toContain("price=ask");
  });

  it("sends from and to as ISO", () => {
    const u = oandaCandlesUrl("a", base);
    expect(u).toContain("from=2024-01-02T00%3A00%3A00.000Z");
  });

  it("refuses an interval OANDA does not have, instead of guessing", () => {
    expect(() => oandaCandlesUrl("a", { ...base, intervalMinutes: 7 }))
      .toThrow(/no 7-minute granularity/);
  });

  it("uses the live host when practice is false", () => {
    expect(oandaCandlesUrl("a", { ...base, practice: false })).toContain("api-fxtrade.oanda.com");
  });
});

describe("parseOandaCandles", () => {
  const mk = (over: Partial<Parameters<typeof parseOandaCandles>[0][number]>) => ({
    complete: true, volume: 10, time: "2024-01-02T00:00:00.000000000Z",
    mid: { o: "1.1", h: "1.2", l: "1.0", c: "1.15" },
    ...over,
  });

  it("parses a complete candle", () => {
    const out = parseOandaCandles([mk({})], "mid");
    expect(out).toHaveLength(1);
    expect(out[0]!.open).toBe(1.1);
    expect(out[0]!.close).toBe(1.15);
    expect(out[0]!.time).toBe(Date.UTC(2024, 0, 2) / 1000);
  });

  it("DROPS a forming candle, so a backtest does not depend on when it ran", () => {
    expect(parseOandaCandles([mk({ complete: false })], "mid")).toHaveLength(0);
  });

  it("reads the requested component", () => {
    const bid = { complete: true, volume: 1, time: "2024-01-02T00:00:00Z",
      bid: { o: "1.0", h: "1.1", l: "0.9", c: "1.05" } };
    expect(parseOandaCandles([bid], "bid")[0]!.open).toBe(1.0);
  });

  it("falls back rather than producing zeros when the block is missing", () => {
    // a bid request answered with only `mid` must not silently become 0
    const midOnly = { complete: true, volume: 1, time: "2024-01-02T00:00:00Z",
      mid: { o: "1.1", h: "1.2", l: "1.0", c: "1.15" } };
    expect(parseOandaCandles([midOnly], "bid")[0]!.open).toBe(1.1);
  });

  it("skips a candle with no price block at all", () => {
    expect(parseOandaCandles([{ complete: true, volume: 1, time: "2024-01-02T00:00:00Z" }], "mid"))
      .toHaveLength(0);
  });

  it("skips a non-numeric price", () => {
    const bad = mk({ mid: { o: "x", h: "1.2", l: "1.0", c: "1.15" } });
    expect(parseOandaCandles([bad], "mid")).toHaveLength(0);
  });

  it("sorts the result", () => {
    const a = mk({ time: "2024-01-02T00:05:00Z" });
    const b = mk({ time: "2024-01-02T00:00:00Z" });
    const out = parseOandaCandles([a, b], "mid");
    expect(out[0]!.time).toBeLessThan(out[1]!.time);
  });
});

describe("validateBridgeResponse", () => {
  it("accepts a well-formed response", () => {
    const r = validateBridgeResponse({ candles: [
      { time: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 },
    ] });
    expect(r.candles).toHaveLength(1);
    expect(r.error).toBeUndefined();
  });

  it("SURFACES the bridge's own error, so a login failure is diagnosable", () => {
    const r = validateBridgeResponse({ candles: [], error: "symbol EURUSD not available" });
    expect(r.candles).toHaveLength(0);
    expect(r.error).toContain("not available");
  });

  it("distinguishes an empty range from a broken bridge", () => {
    // both are empty arrays, but only one means something is wrong
    const empty = validateBridgeResponse({ candles: [] });
    expect(empty.error).toContain("no usable bars");
  });

  it("rejects a non-object", () => {
    expect(validateBridgeResponse(null).error).toContain("non-object");
    expect(validateBridgeResponse("x").error).toContain("non-object");
  });

  it("rejects a missing candles array", () => {
    expect(validateBridgeResponse({}).error).toContain("no candles array");
  });

  it("drops rows with a non-numeric price without failing the batch", () => {
    const r = validateBridgeResponse({ candles: [
      { time: 1, open: 1, high: 2, low: 0.5, close: 1.5 },
      { time: 2, open: "bad", high: 2, low: 0.5, close: 1.5 },
    ] });
    expect(r.candles).toHaveLength(1);
  });

  it("sorts the bars", () => {
    const r = validateBridgeResponse({ candles: [
      { time: 60, open: 1, high: 2, low: 0.5, close: 1.5 },
      { time: 0, open: 1, high: 2, low: 0.5, close: 1.5 },
    ] });
    expect(r.candles[0]!.time).toBe(0);
  });
});

describe("describeTransport", () => {
  it("explains why a terminal is needed", () => {
    expect(describeTransport("terminal-bridge")).toContain("terminal");
  });

  it("explains REST briefly", () => {
    expect(describeTransport("rest")).toContain("HTTPS");
  });
});
