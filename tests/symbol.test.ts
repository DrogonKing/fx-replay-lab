import { describe, it, expect } from "vitest";
import {
  findSymbol,
  normaliseLots,
  roundPrice,
  moneyFromPriceDelta,
  priceDeltaFromMoney,
  requiredMargin,
  lotsForRisk,
  DEFAULT_SYMBOLS,
  hasDedicatedSpec,
} from "../src/core/symbol.js";

const GOLD = findSymbol("XAUUSD");
const EUR = findSymbol("EURUSD");

describe("findSymbol", () => {
  it("returns the dedicated spec for a known name", () => {
    expect(findSymbol("XAUUSD").digits).toBe(2);
    expect(findSymbol("XAUUSD").contractSize).toBe(100);
  });

  it("resolves provider ids through the alias map", () => {
    // Yahoo's gold id is GC=F; the money math needs the XAUUSD contract size.
    expect(findSymbol("GC=F").contractSize).toBe(100);
    expect(findSymbol("GC=F").digits).toBe(2);
    expect(findSymbol("^GSPC").name).toBe("SPX500");
    expect(findSymbol("BTC-USD").name).toBe("BTCUSD");
  });

  it("never throws on an unknown name", () => {
    // Throwing here took down the whole strategy panel whenever a live symbol
    // had no dedicated spec, so the fallback is deliberate: a generic spec beats
    // a dead UI, and hasDedicatedSpec() lets callers warn if they care.
    const s = findSymbol("SOMEUSERCSV");
    expect(s.name).toBe("SOMEUSERCSV");
    expect(Number.isFinite(s.contractSize)).toBe(true);
    expect(s.lotMin).toBeGreaterThan(0);
  });

  it("reports whether a name has dedicated money math", () => {
    expect(hasDedicatedSpec("XAUUSD")).toBe(true);
    expect(hasDedicatedSpec("GC=F")).toBe(true);
    expect(hasDedicatedSpec("SOMEUSERCSV")).toBe(false);
  });

  it("exposes every default symbol", () => {
    const names = DEFAULT_SYMBOLS.map((s) => s.name);
    expect(names).toContain("XAUUSD");
    expect(names).toContain("EURUSD");
    expect(names).toContain("BTCUSD");
    expect(names).toContain("SPX500");
    expect(names.length).toBeGreaterThanOrEqual(8);
  });
});

describe("roundPrice", () => {
  it("rounds to the symbol digit count", () => {
    expect(roundPrice(2399.9999999, GOLD)).toBe(2400);
    expect(roundPrice(1.23456789, EUR)).toBe(1.23457);
  });
});

describe("normaliseLots", () => {
  it("snaps to the lot step", () => {
    expect(normaliseLots(0.017, GOLD)).toBe(0.01);
    expect(normaliseLots(0.019, GOLD)).toBe(0.01);
    expect(normaliseLots(1.239, GOLD)).toBe(1.23);
  });
  it("clamps to min and max", () => {
    expect(normaliseLots(0, GOLD)).toBe(GOLD.lotMin);
    expect(normaliseLots(-5, GOLD)).toBe(GOLD.lotMin);
    expect(normaliseLots(1e9, GOLD)).toBe(GOLD.lotMax);
  });
  it("removes float dust", () => {
    const v = normaliseLots(0.1 + 0.2, GOLD);
    expect(String(v)).toBe("0.3");
  });
});

describe("money conversions", () => {
  it("converts a price move to money", () => {
    // gold: 1.00 move x 100 contract x 1 lot = $100
    expect(moneyFromPriceDelta(1, 1, GOLD)).toBe(100);
    expect(moneyFromPriceDelta(0.5, 2, GOLD)).toBe(100);
  });
  it("inverts back to a price distance", () => {
    expect(priceDeltaFromMoney(100, 1, GOLD)).toBe(1);
    expect(priceDeltaFromMoney(0, 1, GOLD)).toBe(0);
  });
  it("refuses when the profit currency is not the account currency", () => {
    const alien = { ...GOLD, profitCurrencyIsAccount: false, quoteCurrency: "JPY" };
    expect(() => moneyFromPriceDelta(1, 1, alien)).toThrow(/conversion rate/);
  });
});

describe("requiredMargin", () => {
  it("is notional divided by leverage", () => {
    expect(requiredMargin(1, 2000, GOLD, 100)).toBeCloseTo(2000, 9);
    expect(requiredMargin(1, 2000, GOLD, 500)).toBeCloseTo(400, 9);
  });
});

describe("lotsForRisk", () => {
  it("sizes from risk percent and SL distance", () => {
    // $10000, 1% = $100 risk; SL 5.00 on gold = $500 per lot -> 0.2 lots
    expect(lotsForRisk(10_000, 1, 5, GOLD)).toBeCloseTo(0.2, 6);
  });
  it("returns 0 when there is no stop distance", () => {
    expect(lotsForRisk(10_000, 1, 0, GOLD)).toBe(0);
  });
  it("respects lotMin when the risk is tiny", () => {
    expect(lotsForRisk(100, 0.1, 50, GOLD)).toBe(GOLD.lotMin);
  });
});
