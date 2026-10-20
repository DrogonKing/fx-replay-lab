import { describe, it, expect } from "vitest";
import {
  limitFill, stopFill, stopTriggered, processBar, validateOrder, describeOrder,
  type PendingOrder, type Bar,
} from "../src/core/orders.js";

const bar = (o: Partial<Bar> = {}): Bar => ({
  time: 1000, open: 2000, high: 2010, low: 1990, close: 2000, ...o,
});

function order(over: Partial<PendingOrder> = {}): PendingOrder {
  return {
    id: "o1", side: "buy", kind: "limit", lots: 0.1, price: 1980,
    slDistance: 10, tpDistance: 20, createdAt: 0, status: "pending", ...over,
  };
}

describe("limitFill — the four directions", () => {
  it("buy limit fills when price falls to it", () => {
    const f = limitFill("buy", 1995, bar({ open: 2000, low: 1990 }));
    expect(f).toEqual({ price: 1995, reason: "trigger" });
  });

  it("buy limit does NOT fill when price stays above it", () => {
    expect(limitFill("buy", 1980, bar({ low: 1990 }))).toBeNull();
  });

  it("buy limit gaps DOWN through the limit and fills at the open", () => {
    // better than the limit: you get filled cheaper, which is what a real book does
    const f = limitFill("buy", 1995, bar({ open: 1960, high: 1970, low: 1950 }));
    expect(f).toEqual({ price: 1960, reason: "gap" });
  });

  it("sell limit fills when price rises to it", () => {
    const f = limitFill("sell", 2005, bar({ high: 2010, open: 2000 }));
    expect(f).toEqual({ price: 2005, reason: "trigger" });
  });

  it("sell limit does NOT fill when price stays below it", () => {
    expect(limitFill("sell", 2020, bar({ high: 2010 }))).toBeNull();
  });

  it("sell limit gaps UP through the limit and fills at the open", () => {
    const f = limitFill("sell", 2005, bar({ open: 2040, high: 2050, low: 2035 }));
    expect(f).toEqual({ price: 2040, reason: "gap" });
  });
});

describe("stopFill — the four directions", () => {
  it("buy stop triggers when price rises through it", () => {
    const f = stopFill("buy", 2005, bar({ high: 2010, open: 2000 }));
    expect(f).toEqual({ price: 2005, reason: "trigger" });
  });

  it("buy stop does NOT trigger below the bar's high", () => {
    expect(stopFill("buy", 2020, bar({ high: 2010 }))).toBeNull();
  });

  it("buy stop gaps UP and fills at the open — worse than the stop", () => {
    // this is the slippage that flatters every breakout backtest when ignored
    const f = stopFill("buy", 2005, bar({ open: 2030, high: 2040, low: 2025 }));
    expect(f).toEqual({ price: 2030, reason: "gap" });
    expect(f!.price).toBeGreaterThan(2005);
  });

  it("sell stop triggers when price falls through it", () => {
    const f = stopFill("sell", 1995, bar({ low: 1990, open: 2000 }));
    expect(f).toEqual({ price: 1995, reason: "trigger" });
  });

  it("sell stop does NOT trigger above the bar's low", () => {
    expect(stopFill("sell", 1980, bar({ low: 1990 }))).toBeNull();
  });

  it("sell stop gaps DOWN and fills at the open — worse than the stop", () => {
    const f = stopFill("sell", 1995, bar({ open: 1950, high: 1955, low: 1940 }));
    expect(f).toEqual({ price: 1950, reason: "gap" });
    expect(f!.price).toBeLessThan(1995);
  });
});

describe("stopTriggered", () => {
  it("reports whether the stop leg was touched", () => {
    expect(stopTriggered("buy", 2005, bar({ high: 2010 }))).toBe(true);
    expect(stopTriggered("buy", 2020, bar({ high: 2010 }))).toBe(false);
    expect(stopTriggered("sell", 1995, bar({ low: 1990 }))).toBe(true);
    expect(stopTriggered("sell", 1980, bar({ low: 1990 }))).toBe(false);
  });
});

describe("processBar", () => {
  it("fills a limit that the bar reached", () => {
    const r = processBar([order({ price: 1995 })], bar({ low: 1990 }));
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.price).toBe(1995);
    expect(r.remaining).toHaveLength(0);
    expect(r.filled[0]!.status).toBe("filled");
  });

  it("leaves an unreached limit pending", () => {
    const r = processBar([order({ price: 1980 })], bar({ low: 1990 }));
    expect(r.fills).toHaveLength(0);
    expect(r.remaining).toHaveLength(1);
    expect(r.remaining[0]!.status).toBe("pending");
  });

  it("does not mutate the input orders", () => {
    const o = order({ price: 1995 });
    processBar([o], bar({ low: 1990 }));
    expect(o.status).toBe("pending");
  });

  it("fills several orders from one bar", () => {
    const r = processBar(
      [order({ id: "a", price: 1995 }), order({ id: "b", price: 1992, side: "sell", kind: "stop" })],
      bar({ low: 1990 }),
    );
    // buy limit at 1995 fills; sell stop at 1992 also triggers on the way down
    expect(r.fills.map((f) => f.order.id).sort()).toEqual(["a", "b"]);
  });

  it("ignores orders that are not pending", () => {
    const r = processBar(
      [order({ status: "filled", price: 1995 })],
      bar({ low: 1990 }),
    );
    expect(r.fills).toHaveLength(0);
    expect(r.remaining).toHaveLength(0);
  });
});

describe("stop-limit", () => {
  it("fills at the TRIGGER price, not the bar open", () => {
    // buy stop-limit: stop 2005, limit 2008. Price rises through 2005, so the fill
    // happens at 2005 — the price when it became a live order. Filling at the bar's
    // open (2000) would invent a better entry than the market offered.
    const o = order({ kind: "stop-limit", side: "buy", price: 2005, limitPrice: 2008 });
    const r = processBar([o], bar({ open: 2000, high: 2015, low: 1998 }));
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.order.triggered).toBe(true);
    expect(r.fills[0]!.price).toBe(2005);
    expect(r.fills[0]!.reason).toBe("trigger");
  });

  it("stays armed when the gapped trigger price breaches the limit", () => {
    // price gaps up past both the stop (2005) and the limit (2008): the order
    // becomes a live limit but cannot be filled at an acceptable price
    const o = order({ kind: "stop-limit", side: "buy", price: 2005, limitPrice: 2008 });
    const r = processBar([o], bar({ open: 2020, high: 2030, low: 2015 }));
    expect(r.fills).toHaveLength(0);
    expect(r.remaining).toHaveLength(1);
    expect(r.remaining[0]!.triggered).toBe(true);
  });

  it("fills an already-armed stop-limit at its limit", () => {
    const armed = order({
      kind: "stop-limit", side: "buy", price: 2005, limitPrice: 2002, triggered: true,
    });
    // once armed it is a plain buy limit at 2002; price trades down to it
    const r = processBar([armed], bar({ open: 2002, high: 2004, low: 1998 }));
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.price).toBe(2002);
  });

  it("does not arm when the stop is untouched", () => {
    const o = order({ kind: "stop-limit", side: "buy", price: 2020, limitPrice: 2018 });
    const r = processBar([o], bar({ high: 2010 }));
    expect(r.fills).toHaveLength(0);
    expect(r.remaining[0]!.triggered).toBeFalsy();
  });
});

describe("OCO", () => {
  it("cancels the siblings when one order fills", () => {
    const a = order({ id: "a", price: 1995, ocoGroup: "g1" });
    const b = order({ id: "b", side: "sell", kind: "stop", price: 1992, ocoGroup: "g1" });
    const r = processBar([a, b], bar({ low: 1990 }));

    // both could fill on the same bar; whichever fires, the group is consumed
    expect(r.filled.length).toBeGreaterThanOrEqual(1);
    expect(r.remaining).toHaveLength(0);
    const firedIds = r.filled.map((o) => o.id);
    for (const c of r.cancelled) {
      expect(firedIds).not.toContain(c.id);
      expect(c.cancelReason).toContain("OCO");
    }
  });

  it("leaves the group alone when nothing fills", () => {
    // a buy limit BELOW the bar's low and a sell stop ABOVE the bar's high: neither
    // can trigger. (A sell stop above the market would fire immediately, which is
    // why validateOrder refuses that shape.)
    const a = order({ id: "a", price: 1980, ocoGroup: "g1" });
    const b = order({ id: "b", side: "sell", kind: "stop", price: 1985, ocoGroup: "g1" });
    const r = processBar([a, b], bar({ open: 2000, high: 2010, low: 1990 }));
    expect(r.fills).toHaveLength(0);
    expect(r.remaining).toHaveLength(2);
    expect(r.cancelled).toHaveLength(0);
  });

  it("does not touch orders outside the group", () => {
    const a = order({ id: "a", price: 1995, ocoGroup: "g1" });
    const other = order({ id: "c", price: 1900 });
    const r = processBar([a, other], bar({ low: 1990 }));
    expect(r.remaining.map((o) => o.id)).toEqual(["c"]);
  });
});

describe("validateOrder", () => {
  const limits = { minLot: 0.01, maxLot: 100 };

  it("accepts a sane buy limit below the market", () => {
    expect(validateOrder(
      { side: "buy", kind: "limit", lots: 0.1, price: 1990 }, 2000, limits,
    )).toBeNull();
  });

  it("refuses a buy limit ABOVE the market", () => {
    // it would fill instantly: that is a market order the user did not ask for
    const err = validateOrder(
      { side: "buy", kind: "limit", lots: 0.1, price: 2010 }, 2000, limits,
    );
    expect(err).toContain("above the market");
  });

  it("refuses a sell limit BELOW the market", () => {
    expect(validateOrder(
      { side: "sell", kind: "limit", lots: 0.1, price: 1990 }, 2000, limits,
    )).toContain("below the market");
  });

  it("refuses a buy stop BELOW the market", () => {
    expect(validateOrder(
      { side: "buy", kind: "stop", lots: 0.1, price: 1990 }, 2000, limits,
    )).toContain("below the market");
  });

  it("accepts a buy stop above the market", () => {
    expect(validateOrder(
      { side: "buy", kind: "stop", lots: 0.1, price: 2010 }, 2000, limits,
    )).toBeNull();
  });

  it("requires a limit price for stop-limit", () => {
    expect(validateOrder(
      { side: "buy", kind: "stop-limit", lots: 0.1, price: 2010 }, 2000, limits,
    )).toContain("needs a limit price");
  });

  it("requires the buy stop-limit limit at or above its stop", () => {
    expect(validateOrder(
      { side: "buy", kind: "stop-limit", lots: 0.1, price: 2010, limitPrice: 2005 },
      2000, limits,
    )).toContain("at or above");
  });

  it("requires the sell stop-limit limit at or below its stop", () => {
    expect(validateOrder(
      { side: "sell", kind: "stop-limit", lots: 0.1, price: 1990, limitPrice: 1995 },
      2000, limits,
    )).toContain("at or below");
  });

  it("rejects bad lot sizes", () => {
    expect(validateOrder({ side: "buy", kind: "limit", lots: 0, price: 1990 }, 2000, limits))
      .toContain("positive");
    expect(validateOrder({ side: "buy", kind: "limit", lots: 0.001, price: 1990 }, 2000, limits))
      .toContain("below the minimum");
    expect(validateOrder({ side: "buy", kind: "limit", lots: 500, price: 1990 }, 2000, limits))
      .toContain("above the maximum");
  });

  it("rejects a non-positive price", () => {
    expect(validateOrder({ side: "buy", kind: "limit", lots: 0.1, price: 0 }, 2000, limits))
      .toContain("price must be positive");
  });
});

describe("describeOrder", () => {
  it("labels the order readably", () => {
    expect(describeOrder(order({ side: "buy", kind: "limit", lots: 0.5, price: 1980 })))
      .toBe("buy limit 0.5 @ 1980");
  });

  it("includes the limit for a stop-limit", () => {
    expect(describeOrder(order({ kind: "stop-limit", price: 2010, limitPrice: 2012 })))
      .toBe("buy stop-limit 0.1 @ 2010 limit 2012");
  });
});
