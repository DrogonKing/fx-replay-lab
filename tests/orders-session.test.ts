import { describe, it, expect, beforeEach } from "vitest";
import { TradingSession } from "../src/renderer/trading.js";
import { resetIdsForTest } from "../src/core/account.js";
import type { Candle } from "../src/core/types.js";

const bar = (o: Partial<Candle> = {}): Candle => ({
  time: 1000, open: 2000, high: 2001, low: 1999, close: 2000, volume: 1, ...o,
});

beforeEach(() => resetIdsForTest());

/** A session with a live price so orders can be validated against the market. */
function session(): TradingSession {
  const s = new TradingSession("XAUUSD");
  s.setPrice(2000, 1000);
  return s;
}

describe("placing pending orders", () => {
  it("places a buy limit below the market", () => {
    const s = session();
    const r = s.placeOrder({
      side: "buy", kind: "limit", lots: 0.1, price: 1990,
      slDistance: 10, tpDistance: 20,
    });
    expect(r.ok).toBe(true);
    expect(s.snapshot().pendingOrders).toHaveLength(1);
  });

  it("refuses a buy limit above the market", () => {
    const s = session();
    const r = s.placeOrder({
      side: "buy", kind: "limit", lots: 0.1, price: 2010,
      slDistance: 10, tpDistance: 20,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("above the market");
    expect(s.snapshot().pendingOrders).toHaveLength(0);
  });

  it("refuses a buy stop below the market", () => {
    const s = session();
    const r = s.placeOrder({
      side: "buy", kind: "stop", lots: 0.1, price: 1990,
      slDistance: 10, tpDistance: 20,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("below the market");
  });

  it("refuses when there is no price yet", () => {
    const s = new TradingSession("XAUUSD");
    expect(s.placeOrder({
      side: "buy", kind: "limit", lots: 0.1, price: 1990,
      slDistance: 10, tpDistance: 20,
    }).message).toContain("no price");
  });
});

describe("limit fills become positions", () => {
  it("opens a position when the limit is reached", () => {
    const s = session();
    s.placeOrder({
      side: "buy", kind: "limit", lots: 0.1, price: 1990,
      slDistance: 10, tpDistance: 20,
    });
    expect(s.snapshot().positions).toHaveLength(0);

    s.onBar(bar({ open: 2000, high: 2001, low: 1988, close: 1992 }));

    const snap = s.snapshot();
    expect(snap.positions).toHaveLength(1);
    expect(snap.pendingOrders).toHaveLength(0);
    expect(snap.orderHistory.some((o) => o.status === "filled")).toBe(true);
  });

  it("does not open when the limit is not reached", () => {
    const s = session();
    s.placeOrder({
      side: "buy", kind: "limit", lots: 0.1, price: 1990,
      slDistance: 10, tpDistance: 20,
    });
    s.onBar(bar({ open: 2000, high: 2001, low: 1995, close: 1998 }));
    expect(s.snapshot().positions).toHaveLength(0);
    expect(s.snapshot().pendingOrders).toHaveLength(1);
  });

  it("fills at the limit price, not the bar close", () => {
    const s = session();
    s.placeOrder({
      side: "buy", kind: "limit", lots: 0.1, price: 1990,
      slDistance: 10, tpDistance: 20,
    });
    s.onBar(bar({ open: 2000, high: 2001, low: 1985, close: 1986 }));
    // A buy limit fills AT the limit, so the entry is 1990 — not the bar's 1986 close.
    // (processOrders converts the fill to a bid-equivalent and the engine adds the
    // spread back, so the round trip lands exactly on the fill price.)
    expect(s.snapshot().positions[0]!.entryPrice).toBeCloseTo(1990, 1);
  });

  it("tags the journal entry with the order kind", () => {
    const s = session();
    const got: Array<{ tags: string[] }> = [];
    s.onJournal((a) => got.push(...(a as Array<{ tags: string[] }>)));

    s.placeOrder({
      side: "buy", kind: "limit", lots: 0.1, price: 1990,
      slDistance: 10, tpDistance: 5, tags: ["pullback"],
    });
    s.onBar(bar({ open: 2000, high: 2001, low: 1988, close: 1992 }));
    s.onBar(bar({ open: 1992, high: 2000, low: 1991, close: 1998 }));  // hits TP

    expect(got).toHaveLength(1);
    expect(got[0]!.tags).toContain("pullback");
    expect(got[0]!.tags).toContain("limit-fill");
  });

  it("applies the stop distance to a filled limit order", () => {
    const s = session();
    s.placeOrder({
      side: "buy", kind: "limit", lots: 0.1, price: 1990,
      slDistance: 10, tpDistance: 100,
    });
    // fill, then immediately drop through the stop on the next bar
    s.onBar(bar({ open: 2000, high: 2001, low: 1988, close: 1990 }));
    const pos = s.snapshot().positions[0]!;
    expect(pos.sl).toBeCloseTo(1980, 0);
  });
});

describe("stop orders", () => {
  it("opens when price rises through the stop", () => {
    const s = session();
    s.placeOrder({
      side: "buy", kind: "stop", lots: 0.1, price: 2010,
      slDistance: 10, tpDistance: 20,
    });
    // fills at 2010, then the bar must close ABOVE the resulting stop (~2000) or the
    // engine's same-bar SL pass would close it again
    s.onBar(bar({ open: 2000, high: 2012, low: 2006, close: 2011 }));
    const snap = s.snapshot();
    expect(snap.positions).toHaveLength(1);
    expect(snap.positions[0]!.entryPrice).toBeCloseTo(2010, 1);
  });

  it("does not open while price stays below", () => {
    const s = session();
    s.placeOrder({
      side: "buy", kind: "stop", lots: 0.1, price: 2010,
      slDistance: 10, tpDistance: 20,
    });
    s.onBar(bar({ open: 2000, high: 2005, low: 1999, close: 2004 }));
    expect(s.snapshot().positions).toHaveLength(0);
  });
});

describe("stop-limit orders", () => {
  it("arms then fills across two bars", () => {
    const s = session();
    s.placeOrder({
      side: "buy", kind: "stop-limit", lots: 0.1, price: 2010, limitPrice: 2012,
      slDistance: 10, tpDistance: 20,
    });
    // bar 1 touches the stop at 2010; the trigger price 2010 is within the limit
    // 2012 so it fills immediately at 2010 (not at the bar's open)
    s.onBar(bar({ open: 2000, high: 2011, low: 2005, close: 2010 }));
    const snap = s.snapshot();
    expect(snap.positions).toHaveLength(1);
    expect(snap.positions[0]!.entryPrice).toBeCloseTo(2010, 1);
    expect(snap.pendingOrders).toHaveLength(0);
  });

  it("stays armed when a gap blows past the limit", () => {
    const s = session();
    s.placeOrder({
      side: "buy", kind: "stop-limit", lots: 0.1, price: 2010, limitPrice: 2012,
      slDistance: 10, tpDistance: 20,
    });
    // gaps straight to 2025: past the stop (2010) and past the limit (2012)
    s.onBar(bar({ open: 2025, high: 2030, low: 2022, close: 2028 }));
    const snap = s.snapshot();
    expect(snap.positions).toHaveLength(0);
    expect(snap.pendingOrders).toHaveLength(1);
    expect(snap.pendingOrders[0]!.triggered).toBe(true);
  });
});

describe("OCO", () => {
  it("places a pair and cancels the unfilled sibling", () => {
    const s = session();
    const r = s.placeOrder({
      side: "buy", kind: "limit", lots: 0.1, price: 1990,
      slDistance: 10, tpDistance: 20,
      ocoWith: { side: "sell", kind: "stop", price: 1980 },
    });
    expect(r.ok).toBe(true);
    expect(r.sibling).toBeDefined();
    expect(s.snapshot().pendingOrders).toHaveLength(2);

    // one bar spans BOTH levels (buy limit 1990 and sell stop 1980). Only one may
    // fill: OCO means one-cancels-the-other, so two positions here would be a bug.
    s.onBar(bar({ open: 2000, high: 2001, low: 1975, close: 1978 }));

    const snap = s.snapshot();
    expect(snap.pendingOrders).toHaveLength(0);

    // exactly ONE leg filled. The filled limit (entry 1990, stop 1980) is then stopped
    // out by the same bar's low of 1975, so the evidence is a closed trade plus one
    // cancelled sibling — not an open position.
    expect(snap.orderHistory.filter((o) => o.status === "filled")).toHaveLength(1);
    expect(snap.orderHistory.some((o) => o.cancelReason?.includes("OCO"))).toBe(true);
    expect(snap.trades).toHaveLength(1);
    expect(snap.trades[0]!.reason).toBe("SL");
    // and definitely NOT two opposite positions, which is what OCO prevents
    expect(snap.trades.length).toBeLessThan(2);
  });

  it("fills a single leg when only one level is reached", () => {
    const s = session();
    s.placeOrder({
      side: "buy", kind: "limit", lots: 0.1, price: 1990,
      slDistance: 10, tpDistance: 20,
      ocoWith: { side: "sell", kind: "stop", price: 1970 },
    });
    // reaches the buy limit, not the sell stop
    s.onBar(bar({ open: 2000, high: 2001, low: 1985, close: 1988 }));
    const snap = s.snapshot();
    expect(snap.positions).toHaveLength(1);
    expect(snap.pendingOrders).toHaveLength(0);
  });

  it("refuses a pair whose sibling is invalid", () => {
    const s = session();
    const r = s.placeOrder({
      side: "buy", kind: "limit", lots: 0.1, price: 1990,
      slDistance: 10, tpDistance: 20,
      ocoWith: { side: "sell", kind: "limit", price: 2010 },  // sell limit above market is fine…
    });
    // …but the test needs an invalid one: a sell stop above the market
    expect(r.ok).toBe(true);

    const bad = s.placeOrder({
      side: "buy", kind: "limit", lots: 0.1, price: 1985,
      slDistance: 10, tpDistance: 20,
      ocoWith: { side: "sell", kind: "stop", price: 2010 },
    });
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("OCO sibling");
  });
});

describe("cancelling", () => {
  it("cancels one order by id", () => {
    const s = session();
    const r = s.placeOrder({
      side: "buy", kind: "limit", lots: 0.1, price: 1990,
      slDistance: 10, tpDistance: 20,
    });
    expect(s.cancelOrder(r.order!.id)).toBe(true);
    expect(s.snapshot().pendingOrders).toHaveLength(0);
    expect(s.snapshot().orderHistory[0]!.cancelReason).toBe("user");
  });

  it("returns false for an unknown id", () => {
    expect(session().cancelOrder("nope")).toBe(false);
  });

  it("cancels everything", () => {
    const s = session();
    s.placeOrder({ side: "buy", kind: "limit", lots: 0.1, price: 1990, slDistance: 10, tpDistance: 20 });
    s.placeOrder({ side: "buy", kind: "limit", lots: 0.1, price: 1985, slDistance: 10, tpDistance: 20 });
    expect(s.cancelAllOrders()).toBe(2);
    expect(s.snapshot().pendingOrders).toHaveLength(0);
  });
});

describe("reset clears the book", () => {
  it("drops pending orders and history", () => {
    const s = session();
    s.placeOrder({ side: "buy", kind: "limit", lots: 0.1, price: 1990, slDistance: 10, tpDistance: 20 });
    s.reset();
    expect(s.snapshot().pendingOrders).toHaveLength(0);
    expect(s.snapshot().orderHistory).toHaveLength(0);
  });
});
