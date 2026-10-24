import { describe, expect, it } from "vitest";
import { planMm, type MmRequest } from "../src/core/mm.js";
import type { SymbolSpec } from "../src/core/types.js";

const XAUUSD: SymbolSpec = {
  id: "XAUUSD", digits: 2, contractSize: 100, lotMin: 0.01, lotMax: 100, lotStep: 0.01,
  spread: 0.3, commissionPerLot: 6, pipInPoints: 10,
} as unknown as SymbolSpec;

const EURUSD: SymbolSpec = {
  id: "EURUSD", digits: 5, contractSize: 100_000, lotMin: 0.01, lotMax: 100, lotStep: 0.01,
  spread: 0.0001, commissionPerLot: 7, pipInPoints: 10,
} as unknown as SymbolSpec;

function req(over: Partial<MmRequest>): MmRequest {
  return {
    basis: "balance", unit: "percent", value: 1,
    stopPoints: 200, balance: 10_000, equity: 10_000, freeMargin: 10_000,
    leverage: 100, price: 2000, ...over,
  };
}

describe("planMm — the money-management ticket", () => {
  it("sizes 1% of balance to the exact risk over a points stop", () => {
    // gold, stop 2.00 (200 points): one lot loses 2.00 * 100 oz = $200
    // 1% of 10,000 = $100 -> 0.50 lots
    const p = planMm(req({}), XAUUSD);
    expect(p.ok).toBe(true);
    expect(p.lots).toBeCloseTo(0.5, 6);
    expect(p.riskMoney).toBeCloseTo(100, 4);
  });

  it("rounds DOWN to the lot step, never up", () => {
    // 1.05% = $105 -> 0.525 lots -> steps down to 0.52
    const p = planMm(req({ value: 1.05 }), XAUUSD);
    expect(p.lots).toBeCloseTo(0.52, 6);
    expect(p.riskMoney).toBeLessThanOrEqual(105);
  });

  it("fixed-money mode sizes by the amount, ignoring the balance", () => {
    const p = planMm(req({ unit: "money", value: 250 }), XAUUSD);
    expect(p.ok).toBe(true);
    expect(p.lots).toBeCloseTo(1.25, 6);
    expect(p.riskMoney).toBeCloseTo(250, 4);
  });

  it("equity and free-margin bases read their own field", () => {
    const equity = planMm(req({ basis: "equity", equity: 20_000 }), XAUUSD);
    expect(equity.lots).toBeCloseTo(1, 6);
    const fm = planMm(req({ basis: "freeMargin", freeMargin: 5_000 }), XAUUSD);
    expect(fm.lots).toBeCloseTo(0.25, 6);
  });

  it("refuses with arithmetic when the minimum lot would over-risk", () => {
    // min 0.01 lots over a $2.00 stop risks $2.00; the user asked to risk $1.00
    const p = planMm(req({ unit: "money", value: 1 }), XAUUSD);
    expect(p.ok).toBe(false);
    expect(p.lots).toBe(0);
    expect(p.refusal ?? "").toContain("minimum");
    expect(p.refusal ?? "").toContain("2.00");
  });

  it("caps at the symbol's maximum lot", () => {
    const p = planMm(req({ unit: "money", value: 1_000_000 }), { ...XAUUSD, lotMax: 2 });
    expect(p.ok).toBe(true);
    expect(p.lots).toBe(2);
  });

  it("prices a forex symbol correctly", () => {
    // EURUSD stop 200 points = 0.00200: one lot loses 0.002 * 100,000 = $200
    // 1% of 10,000 = $100 -> 0.50 lots
    const p = planMm(req({ price: 1.1 }), EURUSD);
    expect(p.ok).toBe(true);
    expect(p.lots).toBeCloseTo(0.5, 4);
  });

  it("computes margin at the given leverage", () => {
    const p = planMm(req({ leverage: 100 }), XAUUSD);
    // 0.5 lots * 100 oz * 2000 / 100 = 1,000
    expect(p.margin).toBeCloseTo(1_000, 2);
  });

  it("refuses zero stop and zero risk with named reasons", () => {
    expect(planMm(req({ stopPoints: 0 }), XAUUSD).refusal).toContain("stop distance");
    expect(planMm(req({ value: 0 }), XAUUSD).refusal).toContain("risk value");
    expect(planMm(req({ price: 0 }), XAUUSD).refusal).toContain("no price");
  });
});
