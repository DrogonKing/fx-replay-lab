import { describe, it, expect } from "vitest";
import {
  trailPrice, planPartialClose, partialTriggerPrice, atrSeries,
  type TrailConfig,
} from "../src/core/trailing.js";

const round = (p: number): number => Math.round(p * 100) / 100;

function input(over: Partial<Parameters<typeof trailPrice>[0]> = {}) {
  return {
    side: "buy" as const,
    sl: 1980,
    entryPrice: 2000,
    high: 2010,
    low: 1999,
    close: 2008,
    config: { mode: "distance", value: 5 } as TrailConfig,
    round,
    ...over,
  };
}

describe("trailPrice — distance mode", () => {
  it("trails a buy behind the close", () => {
    // close 2008 - 5 = 2003, tighter than the 1980 stop
    expect(trailPrice(input())).toBe(2003);
  });

  it("trails a sell above the close", () => {
    expect(trailPrice(input({
      side: "sell", sl: 2020, entryPrice: 2000, close: 1992,
    }))).toBe(1997);
  });

  it("never loosens a buy stop", () => {
    // close 1990 - 5 = 1985, above the 1980 stop: tighter, so it moves
    expect(trailPrice(input({ close: 1990 }))).toBe(1985);
    // close 1982 - 5 = 1977, BELOW the 1980 stop: looser, so it is refused
    expect(trailPrice(input({ close: 1982 }))).toBeNull();
  });

  it("never loosens a sell stop", () => {
    // sell: the stop sits above, so TIGHTER means LOWER.
    // close 2010 + 5 = 2015 < 2020 -> tighter, moves
    expect(trailPrice(input({ side: "sell", sl: 2020, close: 2010 }))).toBe(2015);
    // close 2020 + 5 = 2025 > 2020 -> looser, refused
    expect(trailPrice(input({ side: "sell", sl: 2020, close: 2020 }))).toBeNull();
  });

  it("locks in profit by trailing above the entry (the point of a trail)", () => {
    // close 2012 - 5 = 2007, above the 2000 entry. Refusing this was a bug: locking in
    // profit is exactly what a trailing stop does once price has run.
    expect(trailPrice(input({ close: 2012, sl: 1980 }))).toBe(2007);
  });

  it("lands exactly on the entry when the distance matches the move", () => {
    expect(trailPrice(input({ close: 2005, sl: 1980 }))).toBe(2000);
  });

  it("locks in profit for a short too", () => {
    // sell: close 1990 + 5 = 1995, below the 2000 entry
    expect(trailPrice(input({ side: "sell", sl: 2020, close: 1990 }))).toBe(1995);
  });

  it("trails to the candidate even when it is close to the bar low", () => {
    // close 2011 - 5 = 2006; the bar low 2001 must NOT overwrite it. The engine's SL
    // check decides whether it fires, not this function.
    expect(trailPrice(input({ close: 2011, low: 2001, sl: 1980 }))).toBe(2006);
  });

  it("returns null for a non-positive distance", () => {
    expect(trailPrice(input({ config: { mode: "distance", value: 0 } }))).toBeNull();
    expect(trailPrice(input({ config: { mode: "distance", value: -5 } }))).toBeNull();
  });
});

describe("trailPrice — extreme mode", () => {
  it("trails behind the bar's high for a buy", () => {
    // high 2010 - 5 = 2005, tighter than trailing the close (2003)
    expect(trailPrice(input({ config: { mode: "extreme", value: 5 } }))).toBe(2005);
  });

  it("trails behind the bar's low for a sell", () => {
    expect(trailPrice(input({
      side: "sell", sl: 2020, entryPrice: 2000,
      high: 2000, low: 1988, close: 1995,
      config: { mode: "extreme", value: 5 },
    }))).toBe(1993);
  });

  it("is tighter than distance mode on the same bar", () => {
    const dist = trailPrice(input({ config: { mode: "distance", value: 5 } }))!;
    const ext = trailPrice(input({ config: { mode: "extreme", value: 5 } }))!;
    expect(ext).toBeGreaterThan(dist);
  });
});

describe("trailPrice — ATR mode", () => {
  const config: TrailConfig = {
    mode: "atr", value: 2, atr: [0, 0, 4, 6], atrIndex: 2,
  };

  it("uses atr * value as the distance", () => {
    // close 2008 - (4 * 2) = 2000
    expect(trailPrice(input({ config }))).toBe(2000);
  });

  it("scales with the ATR value", () => {
    expect(trailPrice(input({
      config: { mode: "atr", value: 1, atr: [0, 0, 4], atrIndex: 2 },
    }))).toBe(2004);
  });

  it("returns null while the ATR is not yet available", () => {
    // a zero/short-window ATR must not produce a tight stop that later widens
    expect(trailPrice(input({
      config: { mode: "atr", value: 2, atr: [0, 0, 0], atrIndex: 1 },
    }))).toBeNull();
  });

  it("returns null when the index is out of range", () => {
    expect(trailPrice(input({
      config: { mode: "atr", value: 2, atr: [0, 4], atrIndex: 99 },
    }))).toBeNull();
  });
});

describe("trailPrice — no look-ahead", () => {
  it("uses ONLY the bar it is given", () => {
    // same bar, same inputs => same answer, regardless of what comes next. The function
    // takes no future data, which is the structural guarantee.
    const a = trailPrice(input({ close: 2008 }));
    const b = trailPrice(input({ close: 2008 }));
    expect(a).toBe(b);
  });

  it("a worse next bar cannot improve the stop", () => {
    const first = trailPrice(input({ close: 2008 }))!;
    const second = trailPrice(input({ sl: first, close: 1990, low: 1985 }));
    expect(second).toBeNull();
  });
});

describe("planPartialClose", () => {
  it("accepts a clean partial", () => {
    const p = planPartialClose(1, 0.5, 0.01);
    expect(p.valid).toBe(true);
    expect(p.lots).toBe(0.5);
    expect(p.remainder).toBe(0.5);
  });

  it("accepts closing the whole position", () => {
    const p = planPartialClose(0.5, 0.5, 0.01);
    expect(p.valid).toBe(true);
    expect(p.remainder).toBe(0);
  });

  it("refuses more than is open", () => {
    const p = planPartialClose(0.5, 1, 0.01);
    expect(p.valid).toBe(false);
    expect(p.reason).toContain("cannot close");
  });

  it("refuses a non-positive size", () => {
    expect(planPartialClose(1, 0, 0.01).valid).toBe(false);
    expect(planPartialClose(1, -1, 0.01).valid).toBe(false);
  });

  it("refuses a remainder that is not on the lot step", () => {
    // closing 0.5 of 1.0 leaves 0.5, and 0.5 is not a multiple of a 0.3 step
    const p = planPartialClose(1, 0.5, 0.3);
    expect(p.valid).toBe(false);
    expect(p.reason).toContain("multiple");
  });

  it("accepts an on-step remainder", () => {
    expect(planPartialClose(1, 0.4, 0.1).valid).toBe(true);
  });
});

describe("partialTriggerPrice", () => {
  const pos = { side: "buy" as const, entryPrice: 2000, sl: 1990 };

  it("computes the price at 1R", () => {
    expect(partialTriggerPrice(pos, 1)).toBe(2010);
  });

  it("computes the price at 2R", () => {
    expect(partialTriggerPrice(pos, 2)).toBe(2020);
  });

  it("works for a short", () => {
    expect(partialTriggerPrice({ side: "sell", entryPrice: 2000, sl: 2010 }, 1)).toBe(1990);
  });

  it("returns null without a stop", () => {
    expect(partialTriggerPrice({ side: "buy", entryPrice: 2000, sl: null }, 1)).toBeNull();
  });

  it("returns null for a non-positive R", () => {
    expect(partialTriggerPrice(pos, 0)).toBeNull();
  });

  it("returns null for a zero risk distance", () => {
    expect(partialTriggerPrice({ side: "buy", entryPrice: 2000, sl: 2000 }, 1)).toBeNull();
  });
});

describe("atrSeries", () => {
  it("is zero until the window is full", () => {
    const a = atrSeries([10, 11, 12], [9, 10, 11], [9.5, 10.5, 11.5], 3);
    expect(a[0]).toBe(0);
    expect(a[1]).toBe(0);
    expect(a[2]).toBeGreaterThan(0);
  });

  it("produces a positive value once full", () => {
    const high = Array.from({ length: 20 }, (_, i) => 100 + i);
    const low = high.map((h) => h - 2);
    const close = high.map((h) => h - 1);
    const a = atrSeries(high, low, close, 14);
    expect(a[13]).toBeGreaterThan(0);
    expect(a[19]).toBeGreaterThan(0);
  });

  it("handles an empty series", () => {
    expect(atrSeries([], [], [], 14)).toEqual([]);
  });

  it("never returns a negative ATR", () => {
    const high = [10, 10, 10, 10];
    const low = [9, 9, 9, 9];
    const close = [9.5, 9.5, 9.5, 9.5];
    for (const v of atrSeries(high, low, close, 2)) expect(v).toBeGreaterThanOrEqual(0);
  });
});
