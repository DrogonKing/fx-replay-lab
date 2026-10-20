import { describe, it, expect } from "vitest";
import {
  rolloversBetween, swapFor, slippageFor, marginState, marginLevelPercent,
  describeMargin, DEFAULT_SWAP, DEFAULT_SLIPPAGE, DEFAULT_MARGIN_CALL,
  type SwapSpec, type SlippageSpec,
} from "../src/core/costs.js";
import { DEFAULT_SYMBOLS } from "../src/core/symbol.js";

const GOLD = DEFAULT_SYMBOLS.find((s) => s.name === "XAUUSD")!;
const T0 = Date.UTC(2024, 0, 8, 0, 0, 0) / 1000;   // Monday 00:00 UTC

describe("rolloversBetween", () => {
  it("counts zero within the same day before rollover", () => {
    // Monday 00:00 -> Monday 20:00, rollover is 21:00
    expect(rolloversBetween(T0, T0 + 20 * 3600).count).toBe(0);
  });

  it("counts the rollover when the window crosses 21:00", () => {
    expect(rolloversBetween(T0, T0 + 22 * 3600).count).toBe(1);
  });

  it("counts one per day", () => {
    expect(rolloversBetween(T0, T0 + 3 * 86400).count).toBe(3);
  });

  it("does not count a rollover exactly AT the start", () => {
    const at = T0 + 21 * 3600;
    expect(rolloversBetween(at, at + 3600).count).toBe(0);
  });

  it("counts a rollover exactly at the END", () => {
    const at = T0 + 21 * 3600;
    expect(rolloversBetween(at - 3600, at).count).toBe(1);
  });

  it("is zero for a reversed or empty window", () => {
    expect(rolloversBetween(T0 + 1000, T0).count).toBe(0);
    expect(rolloversBetween(T0, T0).count).toBe(0);
  });

  it("counts Wednesdays so the weekend can be charged", () => {
    // Monday 00:00 + 7 days crosses Wed, Thu, Fri, Sat, Sun, Mon, Tue
    const r = rolloversBetween(T0, T0 + 7 * 86400);
    expect(r.count).toBe(7);
    expect(r.wednesdays).toBe(1);
  });

  it("respects a different rollover hour", () => {
    const spec: SwapSpec = { ...DEFAULT_SWAP, rolloverHourUtc: 0 };
    // Monday 00:00 is exactly a rollover, so 00:00 -> 01:00 has none after the start
    expect(rolloversBetween(T0, T0 + 3600, spec).count).toBe(0);
    expect(rolloversBetween(T0, T0 + 86400, spec).count).toBe(1);
  });
});

describe("swapFor", () => {
  const rates = { long: -2, short: 1 };

  it("charges a long position", () => {
    // 1 lot, 1 night, -2/lot/night = -2
    expect(swapFor("buy", 1, T0, T0 + 22 * 3600, rates)).toBe(-2);
  });

  it("credits a short position when the rate is positive", () => {
    expect(swapFor("sell", 1, T0, T0 + 22 * 3600, rates)).toBe(1);
  });

  it("scales with lots", () => {
    expect(swapFor("buy", 3, T0, T0 + 22 * 3600, rates)).toBe(-6);
  });

  it("is zero when the rate is zero", () => {
    expect(swapFor("buy", 1, T0, T0 + 22 * 3600, { long: 0, short: 0 })).toBe(0);
  });

  it("is zero for no elapsed time", () => {
    expect(swapFor("buy", 1, T0, T0 + 3600, rates)).toBe(0);
  });

  it("triple-charges the Wednesday night, as a broker does", () => {
    // Mon 00:00 -> Thu 00:00 = 3 rollovers, one of them Wednesday
    const three = swapFor("buy", 1, T0, T0 + 3 * 86400, rates);
    // 3 nights + 2 extra for the Wednesday multiplier = 5 nights at -2 = -10
    expect(three).toBe(-10);
  });

  it("makes a week cost 7 nights of financing, not 5", () => {
    const week = swapFor("buy", 1, T0, T0 + 7 * 86400, rates);
    // 7 + 2 extra = 9 nights at -2
    expect(week).toBe(-18);
  });

  it("can be disabled by a multiplier of 1", () => {
    const spec: SwapSpec = { ...DEFAULT_SWAP, wednesdayMultiplier: 1 };
    expect(swapFor("buy", 1, T0, T0 + 3 * 86400, rates, spec)).toBe(-6);
  });
});

describe("slippageFor", () => {
  const on: SlippageSpec = { marketPoints: 20, stopPoints: 60, limitPoints: 0, enabled: true };

  it("is zero when disabled", () => {
    expect(slippageFor("market", GOLD, 1, { ...on, enabled: false })).toBe(0);
  });

  it("is zero when the configured figure is zero", () => {
    expect(slippageFor("limit", GOLD, 1, on)).toBe(0);
  });

  it("never moves the price in the trader's favour", () => {
    for (let seed = 0; seed < 200; seed++) {
      expect(slippageFor("market", GOLD, seed, on)).toBeGreaterThanOrEqual(0);
    }
  });

  it("never exceeds the configured worst case", () => {
    // 20 points on a 2-digit symbol = 0.20 of price
    for (let seed = 0; seed < 500; seed++) {
      expect(slippageFor("market", GOLD, seed, on)).toBeLessThanOrEqual(0.2 + 1e-9);
    }
  });

  it("is REPRODUCIBLE for the same seed", () => {
    // a replay must give the same fill on the same bar every time
    const a = slippageFor("market", GOLD, 4242, on);
    const b = slippageFor("market", GOLD, 4242, on);
    expect(a).toBe(b);
  });

  it("varies between seeds", () => {
    const vals = new Set<number>();
    for (let s = 0; s < 40; s++) vals.add(slippageFor("market", GOLD, s, on));
    expect(vals.size).toBeGreaterThan(5);
  });

  it("slippage on a stop exceeds slippage on a market order", () => {
    // stops trigger in the worst liquidity, so the figure is larger
    let stopTotal = 0;
    let mktTotal = 0;
    for (let s = 0; s < 100; s++) {
      stopTotal += slippageFor("stop", GOLD, s, on);
      mktTotal += slippageFor("market", GOLD, s, on);
    }
    expect(stopTotal).toBeGreaterThan(mktTotal);
  });

  it("works for a 5-digit symbol", () => {
    const eur = DEFAULT_SYMBOLS.find((s) => s.name === "EURUSD")!;
    const slip = slippageFor("market", eur, 7, on);
    // 20 points on 5 digits = 0.0002 max
    expect(slip).toBeLessThanOrEqual(0.0002 + 1e-12);
  });
});

describe("marginState", () => {
  it("is ok with no margin in use", () => {
    expect(marginState(1000, 0)).toBe("ok");
  });

  it("is ok above the call level", () => {
    expect(marginState(1000, 1000)).toBe("ok");
  });

  it("calls at or below 50% by default", () => {
    expect(marginState(500, 1000)).toBe("call");
    expect(marginState(499, 1000)).toBe("call");
  });

  it("stops out at or below 20%", () => {
    expect(marginState(200, 1000)).toBe("stop-out");
    expect(marginState(100, 1000)).toBe("stop-out");
  });

  it("stops out at zero equity", () => {
    expect(marginState(0, 1000)).toBe("stop-out");
  });

  it("stops out on negative equity", () => {
    expect(marginState(-500, 1000)).toBe("stop-out");
  });

  it("honours a custom threshold", () => {
    expect(marginState(800, 1000, { callLevel: 0.9, stopOutLevel: 0.5 })).toBe("call");
    expect(marginState(400, 1000, { callLevel: 0.9, stopOutLevel: 0.5 })).toBe("stop-out");
  });

  it("has defaults a broker would recognise", () => {
    expect(DEFAULT_MARGIN_CALL.callLevel).toBe(0.5);
    expect(DEFAULT_MARGIN_CALL.stopOutLevel).toBe(0.2);
    expect(DEFAULT_SLIPPAGE.enabled).toBe(false);
    expect(DEFAULT_SWAP.wednesdayMultiplier).toBe(3);
  });
});

describe("marginLevelPercent", () => {
  it("is 100% at parity", () => {
    expect(marginLevelPercent(1000, 1000)).toBe(100);
  });

  it("is 0 with no margin", () => {
    expect(marginLevelPercent(1000, 0)).toBe(0);
  });

  it("rises as equity grows", () => {
    expect(marginLevelPercent(2000, 1000)).toBe(200);
  });
});

describe("describeMargin", () => {
  it("says so when nothing is used", () => {
    expect(describeMargin(1000, 0)).toBe("no margin in use");
  });

  it("names a margin call", () => {
    expect(describeMargin(500, 1000)).toContain("margin call");
  });

  it("names a stop out", () => {
    expect(describeMargin(100, 1000)).toContain("stop out");
  });

  it("reports a healthy level plainly", () => {
    expect(describeMargin(2000, 1000)).toBe("margin level 200%");
  });
});
