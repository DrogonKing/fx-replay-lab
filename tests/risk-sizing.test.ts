import { describe, it, expect } from "vitest";
import {
  planRisk, planRiskFromPoints, pointsToPrice, priceToPoints, riskOfLots,
  rewardRisk, maxStopPoints, type RiskRequest,
} from "../src/core/risk-sizing.js";
import { DEFAULT_SYMBOLS, lotsForRisk } from "../src/core/symbol.js";
import type { SymbolSpec } from "../src/core/types.js";

const GOLD = DEFAULT_SYMBOLS.find((s) => s.name === "XAUUSD")!;
const EURUSD = DEFAULT_SYMBOLS.find((s) => s.name === "EURUSD")!;

const req = (over: Partial<RiskRequest> = {}): RiskRequest => ({
  balance: 10_000,
  riskPercent: 1,
  slDistance: 5,
  price: 2000,
  leverage: 500,
  freeMargin: 10_000,
  ...over,
});

describe("points and price units", () => {
  it("converts points for a 2-digit symbol", () => {
    // gold has 2 digits: 1 point = 0.01 price
    expect(pointsToPrice(100, GOLD)).toBeCloseTo(1, 9);
    expect(pointsToPrice(1, GOLD)).toBeCloseTo(0.01, 9);
  });

  it("converts points for a 5-digit symbol", () => {
    // EURUSD has 5 digits: 1 point = 0.00001 = 0.1 pip
    expect(pointsToPrice(10, EURUSD)).toBeCloseTo(0.0001, 9);
    expect(pointsToPrice(100, EURUSD)).toBeCloseTo(0.001, 9);
  });

  it("round-trips", () => {
    expect(priceToPoints(pointsToPrice(250, GOLD), GOLD)).toBeCloseTo(250, 6);
    expect(priceToPoints(pointsToPrice(37, EURUSD), EURUSD)).toBeCloseTo(37, 6);
  });
});

describe("planRisk — the core rule: never risk more than asked", () => {
  it("sizes from risk percent and stop distance", () => {
    // $10000 * 1% = $100 risk; SL 5.00 on gold = $500/lot -> 0.2 lots
    const p = planRisk(req(), GOLD);
    expect(p.lots).toBeCloseTo(0.2, 6);
    expect(p.riskMoney).toBeCloseTo(100, 6);
    expect(p.actualRiskPercent).toBeCloseTo(1, 6);
  });

  it("rounds DOWN, never up, so risk stays within budget", () => {
    // 0.237 lots would be the exact answer; flooring to 0.01 gives 0.23 and $115 risk
    const p = planRisk(req({ slDistance: 4.21 }), GOLD);
    expect(p.lots).toBeLessThanOrEqual(0.24);
    expect(p.actualRiskPercent).toBeLessThanOrEqual(1.0000001);
    // and it must actually be on the lot step
    expect(Math.round(p.lots * 100) / 100).toBeCloseTo(p.lots, 9);
  });

  it("REFUSES rather than rounding up when the minimum lot exceeds the budget", () => {
    // this is the bug in lotsForRisk: it returns lotMin, quietly over-risking.
    // $100 balance, 0.1% = $0.10 risk, SL 50 on gold = $5000/lot
    const p = planRisk(req({ balance: 100, riskPercent: 0.1, slDistance: 50 }), GOLD);
    expect(p.lots).toBe(0);
    expect(p.overBudget).toBe(true);
    expect(p.reason).toContain("more than the 0.1% asked for");
  });

  it("shows the real risk of the minimum lot in the refusal", () => {
    const p = planRisk(req({ balance: 100, riskPercent: 0.1, slDistance: 50 }), GOLD);
    // 0.01 lots * 50 * 100 = $50 on a $100 balance = 50%
    expect(p.reason).toContain("50.00");
    expect(p.reason).toContain("50.00%");
  });

  it("agrees with lotsForRisk when the size is above the minimum", () => {
    // the old function is correct in its normal range; only the sub-minimum case is unsafe
    const mine = planRisk(req({ slDistance: 5 }), GOLD).lots;
    expect(mine).toBeCloseTo(lotsForRisk(10_000, 1, 5, GOLD), 6);
  });

  it("differs from lotsForRisk exactly where it matters", () => {
    const args = [100, 0.1, 50, GOLD] as const;
    expect(lotsForRisk(...args)).toBe(GOLD.lotMin);          // over-risks
    expect(planRisk(req({ balance: 100, riskPercent: 0.1, slDistance: 50 }), GOLD).lots)
      .toBe(0);                                              // refuses
  });
});

describe("planRisk — inputs it refuses", () => {
  it("needs a stop loss", () => {
    const p = planRisk(req({ slDistance: 0 }), GOLD);
    expect(p.lots).toBe(0);
    expect(p.reason).toContain("stop loss is required");
  });

  it("needs a positive balance", () => {
    expect(planRisk(req({ balance: 0 }), GOLD).reason).toContain("balance");
  });

  it("needs a positive risk percent", () => {
    expect(planRisk(req({ riskPercent: 0 }), GOLD).reason).toContain("risk");
  });

  it("refuses a negative risk percent instead of treating it as zero", () => {
    expect(planRisk(req({ riskPercent: -1 }), GOLD).lots).toBe(0);
  });
});

describe("planRisk — margin can only shrink the size", () => {
  it("caps the size when free margin is short", () => {
    // $10000, 1% -> 0.2 lots wants 0.2*100*2000/500 = $80 margin; give only $40
    const p = planRisk(req({ freeMargin: 40 }), GOLD);
    expect(p.lots).toBeLessThan(0.2);
    expect(p.marginLimited).toBe(true);
    expect(p.margin).toBeLessThanOrEqual(40);
  });

  it("refuses when even the minimum lot does not fit", () => {
    const p = planRisk(req({ freeMargin: 1 }), GOLD);
    expect(p.lots).toBe(0);
    expect(p.marginLimited).toBe(true);
    expect(p.reason).toContain("free margin");
  });

  it("reports the reduced risk after a margin cap", () => {
    const p = planRisk(req({ freeMargin: 40 }), GOLD);
    expect(p.actualRiskPercent).toBeLessThan(1);
    expect(p.reason).toContain("reduced to");
  });

  it("never exceeds lotMax even on a huge balance", () => {
    const p = planRisk(req({ balance: 1e12, slDistance: 0.01, freeMargin: 1e12 }), GOLD);
    expect(p.lots).toBeLessThanOrEqual(GOLD.lotMax);
  });
});

describe("planRiskFromPoints", () => {
  it("takes points, which is what the panel collects", () => {
    // 500 points on gold = 5.00 price
    const p = planRiskFromPoints(
      { balance: 10_000, riskPercent: 1, price: 2000, leverage: 500, freeMargin: 10_000 },
      500,
      GOLD,
    );
    expect(p.lots).toBeCloseTo(0.2, 6);
  });

  it("gives the same answer as the price-distance version", () => {
    const a = planRiskFromPoints(
      { balance: 10_000, riskPercent: 2, price: 2000, leverage: 500, freeMargin: 10_000 },
      300, GOLD,
    );
    const b = planRisk(req({ riskPercent: 2, slDistance: 3 }), GOLD);
    expect(a.lots).toBeCloseTo(b.lots, 6);
  });
});

describe("riskOfLots", () => {
  it("reports money and percent for a chosen size", () => {
    const r = riskOfLots(0.5, 5, GOLD, 10_000);
    // 0.5 * 5 * 100 = $250
    expect(r.money).toBeCloseTo(250, 6);
    expect(r.percent).toBeCloseTo(2.5, 6);
  });

  it("returns zero percent with no balance", () => {
    expect(riskOfLots(0.5, 5, GOLD, 0).percent).toBe(0);
  });

  it("is zero for a zero distance", () => {
    expect(riskOfLots(0.5, 0, GOLD, 10_000).money).toBe(0);
  });
});

describe("rewardRisk", () => {
  it("computes the ratio", () => {
    expect(rewardRisk(100, 200)).toBe(2);
    expect(rewardRisk(100, 50)).toBe(0.5);
  });

  it("returns null when either side is missing", () => {
    // an RR computed from a missing stop is a number someone will trust
    expect(rewardRisk(0, 200)).toBeNull();
    expect(rewardRisk(100, 0)).toBeNull();
    expect(rewardRisk(0, 0)).toBeNull();
  });
});

describe("maxStopPoints", () => {
  it("answers 'how wide can my stop be at this risk'", () => {
    // $10000, 1% = $100; min lot 0.01 * 100 contract = $1/point of price -> 100 price units
    const pts = maxStopPoints(10_000, 1, GOLD);
    // 100 price units = 10000 points on a 2-digit symbol
    expect(pts).toBeCloseTo(10_000, 3);
  });

  it("is zero for nonsense inputs", () => {
    expect(maxStopPoints(0, 1, GOLD)).toBe(0);
    expect(maxStopPoints(10_000, 0, GOLD)).toBe(0);
  });

  it("is consistent with planRisk at the boundary", () => {
    const pts = maxStopPoints(10_000, 1, GOLD);
    // sizing at exactly that stop must give the minimum lot
    const p = planRiskFromPoints(
      { balance: 10_000, riskPercent: 1, price: 2000, leverage: 500, freeMargin: 10_000 },
      pts, GOLD,
    );
    expect(p.lots).toBeCloseTo(GOLD.lotMin, 4);
  });
});
