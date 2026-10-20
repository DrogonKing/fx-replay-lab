import { describe, it, expect } from "vitest";
import { TradingSession } from "../src/renderer/trading.js";

const GOLD_PRICE = 2000;

const fresh = (limitPct = 6): TradingSession => {
  const s = new TradingSession("XAUUSD");
  s.setPrice(GOLD_PRICE, 1700000000);
  s.setRiskLimit(limitPct);
  return s;
};

describe("TradingSession — whole-book guard", () => {
  it("reports the book for an empty account", () => {
    const b = fresh().bookRisk();
    expect(b.positions).toHaveLength(0);
    expect(b.totalPercent).toBe(0);
  });

  it("counts an opened position in the book", () => {
    const s = fresh();
    // 0.5 lots, 10.00 stop, contract 100 -> $500 on $10,000 = 5%
    const r = s.open("buy", 0.5, 10, 20);
    expect(r.ok).toBe(true);
    const b = s.bookRisk();
    expect(b.openRisk).toBeCloseTo(500, 4);
    expect(b.openPercent).toBeGreaterThan(4.9);
  });

  it("REFUSES a trade that would exceed the limit", () => {
    // limit 6%; the first 0.5-lot trade is ~5%, so another one must be refused
    const s = fresh(6);
    expect(s.open("buy", 0.5, 10, 20).ok).toBe(true);
    const second = s.open("buy", 0.5, 10, 20);
    expect(second.ok).toBe(false);
    expect(second.message).toContain("book risk");
  });

  it("allows a trade that fits", () => {
    const s = fresh(6);
    expect(s.open("buy", 0.2, 10, 20).ok).toBe(true);   // 2%
    expect(s.open("buy", 0.2, 10, 20).ok).toBe(true);   // 4%
  });

  it("counts PENDING orders in the projection", () => {
    // 0.5 lots open = 5%; a pending 0.2-lot with a 10.00 stop = 2% more -> over 6%
    const s = fresh(6);
    expect(s.open("buy", 0.5, 10, 20).ok).toBe(true);
    const o = s.placeOrder({
      side: "buy", kind: "limit", lots: 0.2, price: 1900,
      slDistance: 10, tpDistance: 20,
    });
    expect(o.ok).toBe(false);
    expect(o.message).toContain("book risk");
  });

  it("refuses a pending order that is fine alone but not on top of the book", () => {
    const s = fresh(6);
    expect(s.open("buy", 0.4, 10, 20).ok).toBe(true);   // 4%
    expect(s.placeOrder({
      side: "buy", kind: "limit", lots: 0.3, price: 1900,
      slDistance: 10, tpDistance: 20,
    }).ok).toBe(false);                                  // +3% = 7%
  });

  it("does not block CLOSING anything", () => {
    // the guard must never imprison the user in a position
    const s = fresh(6);
    expect(s.open("buy", 0.5, 10, 20).ok).toBe(true);
    expect(s.open("buy", 0.5, 10, 20).ok).toBe(false);
    s.closeAll();
    expect(s.bookRisk().positions).toHaveLength(0);
    expect(s.open("buy", 0.5, 10, 20).ok).toBe(true);
  });

  it("is disabled when the limit is 0", () => {
    const s = fresh(0);
    for (let i = 0; i < 5; i++) {
      expect(s.open("buy", 0.5, 10, 20).ok).toBe(true);
    }
  });

  it("is OFF on a brand new session", () => {
    // the app must not police risk until asked to
    const s = new TradingSession("XAUUSD");
    s.setPrice(GOLD_PRICE, 1700000000);
    expect(s.riskLimitPercent).toBe(0);
    // 4 x 0.5 lots = $2,800 at risk on $10,000 (28%), far over any sane book limit, and the
    // margin still permits it. If the guard were on by default this would be refused.
    for (let i = 0; i < 4; i++) {
      expect(s.open("buy", 0.5, 10, 20).ok, `trade ${i}`).toBe(true);
    }
    expect(s.bookRisk().openPercent).toBeGreaterThan(20);
  });

  it("reports unprotected positions in the book", () => {
    const s = fresh(6);
    s.open("buy", 0.2, 0, 20);   // no stop
    const b = s.bookRisk();
    expect(b.unprotectedCount).toBe(1);
    expect(b.openPercent).toBe(0);
  });

  it("exposes the limit it is using", () => {
    expect(fresh(4).riskLimitPercent).toBe(4);
  });

  it("keeps the book current after a close", () => {
    const s = fresh(6);
    s.open("buy", 0.5, 10, 20);
    const before = s.bookRisk().openPercent;
    s.closeAll();
    expect(s.bookRisk().openPercent).toBe(0);
    expect(before).toBeGreaterThan(0);
  });

  it("nets buys against sells for exposure", () => {
    const s = fresh(20);
    s.open("buy", 0.3, 10, 20);
    s.open("sell", 0.1, 10, 20);
    const b = s.bookRisk();
    expect(b.netLots).toBeCloseTo(0.2, 6);
    expect(b.hedged).toBe(true);
  });
});
