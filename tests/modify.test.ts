/**
 * modify — changing a live position or a resting order.
 *
 * The refusal cases are the substance here. A modify that silently accepts a stop on the wrong side of the market is
 * worse than one that fails: the caller books a successful modify, and the position closes on the next tick with no
 * explanation. So most of these tests are about what is REFUSED and why.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  describeModify,
  modifyOrder,
  modifyPosition,
  stopIsValid,
  targetIsValid,
} from "../src/core/modify";
import type { Order, Position } from "../src/core/types";

const position = (over: Partial<Position> = {}): Position => ({
  id: 1,
  accountId: 1,
  symbol: "EURUSD",
  side: "buy",
  lots: 1,
  entryPrice: 1.1,
  entryTime: 0,
  sl: 1.09,
  tp: 1.12,
  trailDistance: null,
  commission: 0,
  swap: 0,
  ...over,
});

const order = (over: Partial<Order> = {}): Order => ({
  id: 7,
  accountId: 1,
  symbol: "EURUSD",
  side: "buy",
  type: "limit",
  lots: 1,
  price: 1.095,
  slDistance: 0.005,
  tpDistance: 0.01,
  createdAt: 0,
  status: "pending",
  ...over,
});

describe("the side rules", () => {
  it("a buy stop sits below and a buy target above", () => {
    expect(stopIsValid("buy", 1.09, 1.1)).toBe(true);
    expect(stopIsValid("buy", 1.11, 1.1)).toBe(false);
    expect(targetIsValid("buy", 1.12, 1.1)).toBe(true);
    expect(targetIsValid("buy", 1.09, 1.1)).toBe(false);
  });

  it("a sell is the mirror image", () => {
    expect(stopIsValid("sell", 1.11, 1.1)).toBe(true);
    expect(stopIsValid("sell", 1.09, 1.1)).toBe(false);
    expect(targetIsValid("sell", 1.08, 1.1)).toBe(true);
    expect(targetIsValid("sell", 1.11, 1.1)).toBe(false);
  });
});

describe("modifyPosition", () => {
  it("moves a stop that stays on the losing side", () => {
    const r = modifyPosition(position(), { sl: 1.095, price: 1.1 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.position?.sl).toBe(1.095);
      expect(r.changed[0]).toContain("sl 1.09 -> 1.095");
    }
  });

  it("REFUSES a stop on the winning side, because that is an immediate close dressed as a modify", () => {
    const r = modifyPosition(position(), { sl: 1.105, price: 1.1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("wrong-side-of-market");
      expect(r.detail).toContain("below");
    }
  });

  it("REFUSES a buy target below the market", () => {
    const r = modifyPosition(position(), { tp: 1.09, price: 1.1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wrong-side-of-market");
  });

  it("applies the symbol's minimum distance", () => {
    const limits = { stopsLevel: 0.002, freezeLevel: 0 };
    const r = modifyPosition(position(), { sl: 1.0985, price: 1.1 }, limits);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too-close-to-market");
  });

  it("allows a stop exactly at the minimum distance, because the rule is a floor not a strict bound", () => {
    const limits = { stopsLevel: 0.002, freezeLevel: 0 };
    const r = modifyPosition(position(), { sl: 1.098, price: 1.1 }, limits);
    expect(r.ok).toBe(true);
  });

  it("clears a level with null and leaves one alone with undefined", () => {
    const cleared = modifyPosition(position(), { sl: null, price: 1.1 });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect(cleared.position?.sl).toBeNull();
      expect(cleared.position?.tp).toBe(1.12); // untouched
    }

    const untouched = modifyPosition(position(), { tp: 1.13, price: 1.1 });
    expect(untouched.ok).toBe(true);
    if (untouched.ok) {
      expect(untouched.position?.sl).toBe(1.09); // not cleared by omission
      expect(untouched.position?.tp).toBe(1.13);
    }
  });

  it("refuses when nothing was asked for, rather than pretending to succeed", () => {
    const r = modifyPosition(position(), { price: 1.1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("nothing-to-change");
  });

  it("refuses a NaN or a missing price", () => {
    expect(modifyPosition(position(), { sl: 1.09, price: Number.NaN }).ok).toBe(false);
    expect(modifyPosition(position(), { sl: 1.09, price: 0 }).ok).toBe(false);
    expect(modifyPosition(position(), { sl: Number.NaN, price: 1.1 }).ok).toBe(false);
  });

  it("never mutates the argument", () => {
    const p = position();
    const before = JSON.stringify(p);
    modifyPosition(p, { sl: 1.095, price: 1.1 });
    expect(JSON.stringify(p)).toBe(before);
  });

  it("moving a stop into loss is ALLOWED, because a wider stop is a normal decision", () => {
    const r = modifyPosition(position(), { sl: 1.06, price: 1.1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.position?.sl).toBe(1.06);
  });

  it("works for a sell position with the mirror rules", () => {
    const p = position({ side: "sell", sl: 1.11, tp: 1.08 });
    const ok = modifyPosition(p, { sl: 1.105, price: 1.1 });
    expect(ok.ok).toBe(true);
    const bad = modifyPosition(p, { sl: 1.095, price: 1.1 });
    expect(bad.ok).toBe(false);
  });
});

describe("modifyOrder", () => {
  it("re-prices a pending limit that stays on the favourable side", () => {
    const r = modifyOrder(order(), { price: 1.094 }, DEFAULT_LIMITS, 1.1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.order?.price).toBe(1.094);
  });

  it("REFUSES a buy limit above the market, because that would be a stop order", () => {
    const r = modifyOrder(order(), { price: 1.105 }, DEFAULT_LIMITS, 1.1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wrong-side-of-market");
  });

  it("REFUSES a filled order: it is a position and its price is history", () => {
    const r = modifyOrder(order({ status: "filled" }), { price: 1.094 }, DEFAULT_LIMITS, 1.1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("order-not-pending");
  });

  it("REFUSES a market order, which does not rest", () => {
    const r = modifyOrder(order({ type: "market" }), { price: 1.094 }, DEFAULT_LIMITS, 1.1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("order-not-pending");
  });

  it("a buy stop must sit ABOVE the market", () => {
    const o = order({ type: "stop", price: 1.105 });
    expect(modifyOrder(o, { price: 1.108 }, DEFAULT_LIMITS, 1.1).ok).toBe(true);
    expect(modifyOrder(o, { price: 1.095 }, DEFAULT_LIMITS, 1.1).ok).toBe(false);
  });

  it("adjusts distances without touching the price", () => {
    const r = modifyOrder(order(), { slDistance: 0.002 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.order?.slDistance).toBe(0.002);
      expect(r.order?.price).toBe(1.095);
    }
  });

  it("refuses a negative stop distance", () => {
    const r = modifyOrder(order(), { slDistance: -0.001 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("non-positive-lots");
  });

  it("refuses a re-price inside the freeze level", () => {
    const limits = { stopsLevel: 0, freezeLevel: 0.003 };
    const r = modifyOrder(order(), { price: 1.098 }, limits, 1.1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too-close-to-market");
  });

  it("refuses an empty request", () => {
    const r = modifyOrder(order(), {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("nothing-to-change");
  });
});

describe("describeModify", () => {
  it("says what changed, and says why when it refused", () => {
    const ok = modifyPosition(position(), { sl: 1.095, price: 1.1 });
    expect(describeModify(ok, "position", 1)).toContain("sl 1.09 -> 1.095");

    const bad = modifyPosition(position(), { sl: 1.105, price: 1.1 });
    expect(describeModify(bad, "position", 1)).toContain("refused");
  });
});