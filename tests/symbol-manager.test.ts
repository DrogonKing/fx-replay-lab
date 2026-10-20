import { describe, it, expect } from "vitest";
import {
  mergeSymbols, validateSymbol, specFromForm, parseSymbols, serialiseSymbols,
  describeSymbol,
} from "../src/core/symbol-manager.js";
import { DEFAULT_SYMBOLS } from "../src/core/symbol.js";
import type { SymbolSpec } from "../src/core/types.js";

const GOLD = DEFAULT_SYMBOLS.find((s) => s.name === "XAUUSD")!;

// A name that is NOT in DEFAULT_SYMBOLS. The first version used BTCUSD, which already
// ships — merging then correctly replaced it and the "adds a symbol" count never changed.
const CUSTOM: SymbolSpec = {
  name: "SOLUSD", digits: 2, pipSize: 0.01, contractSize: 1,
  lotMin: 0.01, lotMax: 10, lotStep: 0.01, spread: 20, spreadMode: "fixed",
  commissionPerLot: 0, swapLong: 0, swapShort: 0, leverage: 10,
  quoteCurrency: "USD", profitCurrencyIsAccount: true,
};

describe("mergeSymbols", () => {
  it("keeps every built-in when nothing is added", () => {
    expect(mergeSymbols([])).toHaveLength(DEFAULT_SYMBOLS.length);
  });

  it("adds a custom symbol", () => {
    const merged = mergeSymbols([CUSTOM]);
    expect(merged).toHaveLength(DEFAULT_SYMBOLS.length + 1);
    expect(merged.some((s) => s.name === "SOLUSD")).toBe(true);
  });

  it("lets a custom REPLACE a built-in of the same name", () => {
    // the whole reason to add one: a broker's real contract size for a pair the repo guesses
    const fixed: SymbolSpec = { ...GOLD, contractSize: 10 };
    const merged = mergeSymbols([fixed]);
    const gold = merged.filter((s) => s.name === "XAUUSD");
    expect(gold).toHaveLength(1);
    expect(gold[0]!.contractSize).toBe(10);
  });

  it("does not duplicate when a custom repeats a built-in name in different case", () => {
    const merged = mergeSymbols([{ ...GOLD, name: "xauusd", contractSize: 1 }]);
    expect(merged.filter((s) => s.name.toUpperCase() === "XAUUSD")).toHaveLength(1);
  });
});

describe("validateSymbol", () => {
  it("accepts a well-formed symbol", () => {
    expect(validateSymbol(CUSTOM).ok).toBe(true);
  });

  it("requires a name", () => {
    const c = validateSymbol({ ...CUSTOM, name: "  " });
    expect(c.ok).toBe(false);
    expect(c.errors.name).toBeTruthy();
  });

  it("refuses a name with a space, which would break the workspace key", () => {
    // the workspace key is `symbol::timeframe`
    const c = validateSymbol({ ...CUSTOM, name: "BTC USD" });
    expect(c.errors.name).toBeTruthy();
  });

  it("refuses a duplicate name", () => {
    const c = validateSymbol(CUSTOM, ["SOLUSD"]);
    expect(c.errors.name).toContain("already exists");
  });

  it("is case-insensitive about duplicates", () => {
    expect(validateSymbol(CUSTOM, ["solusd"]).errors.name).toBeTruthy();
  });

  it("requires a positive contract size, or every P&L is scaled wrong", () => {
    expect(validateSymbol({ ...CUSTOM, contractSize: 0 }).errors.contractSize).toBeTruthy();
    expect(validateSymbol({ ...CUSTOM, contractSize: -1 }).errors.contractSize).toBeTruthy();
  });

  it("requires whole, sane digits", () => {
    expect(validateSymbol({ ...CUSTOM, digits: 2.5 }).errors.digits).toBeTruthy();
    expect(validateSymbol({ ...CUSTOM, digits: 0 }).errors.digits).toBeTruthy();
    expect(validateSymbol({ ...CUSTOM, digits: 20 }).errors.digits).toBeTruthy();
  });

  it("refuses a minimum lot larger than the maximum", () => {
    const c = validateSymbol({ ...CUSTOM, lotMin: 5, lotMax: 1 });
    expect(c.errors.lotMin).toBeTruthy();
  });

  it("refuses a lot step that does not divide the maximum", () => {
    // 10 / 0.3 is not a whole number: the largest size would be unreachable
    const c = validateSymbol({ ...CUSTOM, lotMax: 10, lotStep: 0.3 });
    expect(c.errors.lotStep).toContain("does not divide");
  });

  it("accepts a step that does divide", () => {
    expect(validateSymbol({ ...CUSTOM, lotMax: 10, lotStep: 0.5 }).ok).toBe(true);
  });

  it("refuses a negative spread", () => {
    expect(validateSymbol({ ...CUSTOM, spread: -1 }).errors.spread).toBeTruthy();
  });

  it("accepts a zero spread and zero commission", () => {
    expect(validateSymbol({ ...CUSTOM, spread: 0, commissionPerLot: 0 }).ok).toBe(true);
  });

  it("reports every problem at once, not just the first", () => {
    const c = validateSymbol({ ...CUSTOM, name: "", contractSize: 0, digits: 0 });
    expect(Object.keys(c.errors).length).toBeGreaterThanOrEqual(3);
  });
});

describe("specFromForm", () => {
  const form = {
    name: "ETHUSD", digits: "2", contractSize: "10", lotMin: "0.1",
    lotMax: "50", lotStep: "0.1", spread: "5", commissionPerLot: "0",
  };

  it("builds a valid spec from strings", () => {
    const { spec, check } = specFromForm(form);
    expect(check.ok).toBe(true);
    expect(spec!.name).toBe("ETHUSD");
    expect(spec!.contractSize).toBe(10);
    expect(spec!.lotStep).toBe(0.1);
  });

  it("uppercases the name", () => {
    expect(specFromForm({ ...form, name: "ethusd" }).spec!.name).toBe("ETHUSD");
  });

  it("derives the pip size from the digits when it is not given", () => {
    expect(specFromForm({ ...form, digits: "5" }).spec!.pipSize).toBeCloseTo(0.00001, 9);
  });

  it("returns null and the errors for a bad form", () => {
    const { spec, check } = specFromForm({ ...form, name: "" });
    expect(spec).toBeNull();
    expect(check.ok).toBe(false);
  });

  it("treats an unreadable number as the default rather than NaN", () => {
    // NaN in a contract size would make every P&L NaN and the chart silently empty, so an
    // unreadable field falls back to the default instead of propagating.
    const { spec } = specFromForm({ ...form, contractSize: "abc" });
    expect(spec).not.toBeNull();
    expect(Number.isNaN(spec!.contractSize)).toBe(false);
    expect(spec!.contractSize).toBe(100);
  });
});

describe("parseSymbols", () => {
  it("round-trips a list", () => {
    const out = parseSymbols(JSON.parse(JSON.stringify(serialiseSymbols([CUSTOM]))));
    expect(out.value).toHaveLength(1);
    expect(out.value[0]!.name).toBe("SOLUSD");
    expect(out.rejected).toHaveLength(0);
  });

  it("returns nothing for an empty row without an error", () => {
    expect(parseSymbols(null)).toEqual({ value: [], rejected: [] });
  });

  it("reports a non-list", () => {
    expect(parseSymbols("nonsense").rejected).toHaveLength(1);
  });

  it("drops an invalid entry WITH a reason", () => {
    const out = parseSymbols([{ ...CUSTOM, contractSize: 0 }]);
    expect(out.value).toHaveLength(0);
    expect(out.rejected[0]).toContain("contract size");
  });

  it("keeps the good entries when one is bad", () => {
    const out = parseSymbols([CUSTOM, { ...CUSTOM, name: "BAD", digits: 0 }, { ...CUSTOM, name: "OK2" }]);
    expect(out.value.map((s) => s.name)).toEqual(["SOLUSD", "OK2"]);
    expect(out.rejected).toHaveLength(1);
  });

  it("rejects a duplicate inside the stored list", () => {
    const out = parseSymbols([CUSTOM, { ...CUSTOM }]);
    expect(out.value).toHaveLength(1);
    expect(out.rejected[0]).toContain("already exists");
  });

  it("uppercases the stored name", () => {
    expect(parseSymbols([{ ...CUSTOM, name: "solusd" }]).value[0]!.name).toBe("SOLUSD");
  });
});

describe("describeSymbol", () => {
  it("summarises the parts that matter", () => {
    const d = describeSymbol(CUSTOM);
    expect(d).toContain("SOLUSD");
    expect(d).toContain("2 digits");
    expect(d).toContain("1/lot");
    expect(d).toContain("spread 20");
  });
});
