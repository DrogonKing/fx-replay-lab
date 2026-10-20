import { describe, it, expect } from "vitest";
import {
  positionRisk, pendingRiskOf, bookRisk, checkLimit, headroom, describeBook,
  DEFAULT_LIMIT, type RiskLimit,
} from "../src/core/book-risk.js";
import { DEFAULT_SYMBOLS } from "../src/core/symbol.js";
import type { PendingOrder } from "../src/core/orders.js";

const GOLD = DEFAULT_SYMBOLS.find((s) => s.name === "XAUUSD")!;

const pos = (over: Partial<{
  id: number; symbol: string; side: "buy" | "sell"; lots: number;
  entryPrice: number; sl: number | null;
}> = {}) => ({
  id: 1, symbol: "XAUUSD", side: "buy" as const, lots: 0.1,
  entryPrice: 2000, sl: 1990, ...over,
});

const order = (over: Partial<PendingOrder> = {}): PendingOrder => ({
  id: "o1", side: "buy", kind: "limit", lots: 0.1, price: 1990,
  slDistance: 10, tpDistance: 20, createdAt: 1000, status: "pending", ...over,
});

describe("positionRisk", () => {
  it("prices the stop distance into money", () => {
    // 0.1 lots, 10.00 stop distance, contract 100 -> $100
    const r = positionRisk(pos(), GOLD, 10_000);
    expect(r.money).toBeCloseTo(100, 6);
    expect(r.percent).toBeCloseTo(1, 6);
    expect(r.unprotected).toBe(false);
  });

  it("works for a sell, where the stop is above the entry", () => {
    const r = positionRisk(pos({ side: "sell", entryPrice: 2000, sl: 2010 }), GOLD, 10_000);
    expect(r.stopDistance).toBeCloseTo(10, 6);
    expect(r.money).toBeCloseTo(100, 6);
  });

  it("marks a position with no stop as UNPROTECTED, not as zero risk", () => {
    // counting it as zero would make the book look safer the less protected it is
    const r = positionRisk(pos({ sl: null }), GOLD, 10_000);
    expect(r.unprotected).toBe(true);
    expect(r.money).toBe(0);
    expect(r.percent).toBe(0);
  });

  it("treats a stop exactly at the entry as unprotected too", () => {
    // zero distance means the stop can never limit anything
    const r = positionRisk(pos({ sl: 2000 }), GOLD, 10_000);
    expect(r.unprotected).toBe(true);
    expect(r.money).toBe(0);
  });

  it("scales with lots", () => {
    expect(positionRisk(pos({ lots: 1 }), GOLD, 10_000).money).toBeCloseTo(1000, 6);
    expect(positionRisk(pos({ lots: 0.01 }), GOLD, 10_000).money).toBeCloseTo(10, 6);
  });

  it("returns zero percent with no balance", () => {
    expect(positionRisk(pos(), GOLD, 0).percent).toBe(0);
  });
});

describe("pendingRiskOf", () => {
  it("prices the order's own stop distance", () => {
    expect(pendingRiskOf(order(), GOLD, 10_000)).toBeCloseTo(100, 6);
  });

  it("ignores an order with no stop", () => {
    expect(pendingRiskOf(order({ slDistance: 0 }), GOLD, 10_000)).toBe(0);
  });

  it("ignores orders that are no longer pending", () => {
    expect(pendingRiskOf(order({ status: "filled" }), GOLD, 10_000)).toBe(0);
    expect(pendingRiskOf(order({ status: "cancelled" }), GOLD, 10_000)).toBe(0);
  });
});

describe("bookRisk", () => {
  it("sums the open risk", () => {
    const b = bookRisk(10_000, [pos({ id: 1 }), pos({ id: 2 })], [], GOLD);
    expect(b.openRisk).toBeCloseTo(200, 6);
    expect(b.openPercent).toBeCloseTo(2, 6);
  });

  it("counts each position separately", () => {
    const b = bookRisk(10_000, [pos({ id: 1, lots: 0.3 })], [], GOLD);
    expect(b.positions).toHaveLength(1);
    expect(b.positions[0]!.money).toBeCloseTo(300, 6);
  });

  it("keeps pending risk separate from open risk", () => {
    const b = bookRisk(10_000, [pos()], [order()], GOLD);
    expect(b.openRisk).toBeCloseTo(100, 6);
    expect(b.pendingRisk).toBeCloseTo(100, 6);
    expect(b.totalRisk).toBeCloseTo(200, 6);
    expect(b.totalPercent).toBeCloseTo(2, 6);
  });

  it("counts unprotected positions without adding their risk", () => {
    const b = bookRisk(10_000, [pos({ id: 1 }), pos({ id: 2, sl: null })], [], GOLD);
    expect(b.unprotectedCount).toBe(1);
    // only the protected one contributes
    expect(b.openRisk).toBeCloseTo(100, 6);
  });

  it("computes net and gross exposure", () => {
    const b = bookRisk(
      10_000,
      [pos({ id: 1, side: "buy", lots: 0.3 }), pos({ id: 2, side: "sell", lots: 0.1 })],
      [], GOLD,
    );
    expect(b.netLots).toBeCloseTo(0.2, 6);
    expect(b.grossLots).toBeCloseTo(0.4, 6);
    expect(b.hedged).toBe(true);
  });

  it("is not hedged when only one direction is open", () => {
    const b = bookRisk(10_000, [pos({ id: 1 }), pos({ id: 2 })], [], GOLD);
    expect(b.hedged).toBe(false);
    expect(b.netLots).toBeCloseTo(0.2, 6);
  });

  it("is empty for an empty book", () => {
    const b = bookRisk(10_000, [], [], GOLD);
    expect(b.openRisk).toBe(0);
    expect(b.totalPercent).toBe(0);
    expect(b.positions).toHaveLength(0);
  });

  it("handles a zero balance without dividing by zero", () => {
    const b = bookRisk(0, [pos()], [], GOLD);
    expect(b.openPercent).toBe(0);
    expect(Number.isFinite(b.totalPercent)).toBe(true);
  });
});

describe("checkLimit", () => {
  const limit: RiskLimit = { maxPercent: 3 };

  it("passes when inside the limit", () => {
    const b = bookRisk(10_000, [pos()], [], GOLD);   // 1%
    const c = checkLimit(b, limit);
    expect(c.breach).toBe(false);
    expect(c.wouldBreach).toBe(false);
  });

  it("flags an existing breach", () => {
    const b = bookRisk(10_000, [pos({ lots: 0.5 })], [], GOLD);  // 5%
    const c = checkLimit(b, limit);
    expect(c.breach).toBe(true);
  });

  it("warns about a candidate that would breach even when the book is fine", () => {
    // 1% open, adding 3% would be 4% against a 3% limit
    const b = bookRisk(10_000, [pos()], [], GOLD);
    const c = checkLimit(b, limit, { percent: 3 });
    expect(c.breach).toBe(false);
    expect(c.wouldBreach).toBe(true);
    expect(c.projectedPercent).toBeCloseTo(4, 6);
    expect(c.overBy).toBeCloseTo(1, 6);
  });

  it("explains the projected number in the reason", () => {
    const b = bookRisk(10_000, [pos()], [], GOLD);
    const c = checkLimit(b, limit, { percent: 3 });
    expect(c.reason).toContain("4.00%");
    expect(c.reason).toContain("3%");
  });

  it("mentions unprotected positions, because the number understates the risk", () => {
    const b = bookRisk(10_000, [pos({ sl: null })], [], GOLD);
    const c = checkLimit(b, limit, { percent: 2.5 });
    expect(c.reason).toContain("no stop");
  });

  it("warns about missing stops even when nothing is breached", () => {
    // the dangerous case: risk reads 0% because nothing has a stop, so the limit looks fine
    const b = bookRisk(10_000, [pos({ sl: null })], [], GOLD);
    expect(b.totalPercent).toBe(0);
    const c = checkLimit(b, limit);
    expect(c.breach).toBe(false);
    expect(c.reason).toContain("no stop");
  });

  it("has no reason at all for a clean book", () => {
    const b = bookRisk(10_000, [pos()], [], GOLD);
    expect(checkLimit(b, limit).reason).toBeUndefined();
  });

  it("counts pending orders in the projection", () => {
    // 1% open + 2% pending = 3%, at the limit; a 0.5% trade breaches
    const b = bookRisk(10_000, [pos()], [order({ slDistance: 20 })], GOLD);
    expect(b.totalPercent).toBeCloseTo(3, 6);
    const c = checkLimit(b, limit, { percent: 0.5 });
    expect(c.wouldBreach).toBe(true);
  });

  it("does nothing when the limit is disabled (0)", () => {
    const b = bookRisk(10_000, [pos({ lots: 5 })], [], GOLD);
    const c = checkLimit(b, { maxPercent: 0 });
    expect(c.breach).toBe(false);
    expect(c.wouldBreach).toBe(false);
  });

  it("does not breach on float dust exactly at the limit", () => {
    // 3% exactly must not report as over because of 2.9999999999
    const b = bookRisk(10_000, [pos({ lots: 0.3 })], [], GOLD);
    const c = checkLimit(b, limit);
    expect(c.breach).toBe(false);
  });

  it("is off by default, so the tool never refuses a trade nobody asked it to police", () => {
    expect(DEFAULT_LIMIT.maxPercent).toBe(0);
  });
});

describe("headroom", () => {
  it("reports the room left", () => {
    const b = bookRisk(10_000, [pos()], [], GOLD);   // 1%
    expect(headroom(b, { maxPercent: 5 })).toBeCloseTo(4, 6);
  });

  it("goes NEGATIVE when already over, rather than clamping to zero", () => {
    // clamping would hide an existing breach
    const b = bookRisk(10_000, [pos({ lots: 0.5 })], [], GOLD);  // 5%
    expect(headroom(b, { maxPercent: 3 })).toBeCloseTo(-2, 6);
  });

  it("is infinite when the limit is off", () => {
    const b = bookRisk(10_000, [pos()], [], GOLD);
    expect(headroom(b, { maxPercent: 0 })).toBe(Infinity);
  });
});

describe("describeBook", () => {
  it("summarises a simple book", () => {
    const b = bookRisk(10_000, [pos()], [], GOLD);
    const s = describeBook(b, { maxPercent: 6 });
    expect(s).toContain("1.00%");
    expect(s).toContain("limit 6%");
  });

  it("mentions pending risk when there is any", () => {
    const b = bookRisk(10_000, [pos()], [order()], GOLD);
    expect(describeBook(b, { maxPercent: 6 })).toContain("pending");
  });

  it("mentions positions without a stop", () => {
    const b = bookRisk(10_000, [pos({ sl: null })], [], GOLD);
    expect(describeBook(b, { maxPercent: 6 })).toContain("without a stop");
  });
});
