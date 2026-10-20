import { describe, it, expect } from "vitest";
import {
  positionLines, hitHandle, constrainLevel, riskDistance, rewardDistance,
  currentR, profitInR, breakEven, applyBreakEven, describePosition,
  type PriceLine,
} from "../src/core/position-manage.js";
import type { Position } from "../src/core/types.js";

function pos(over: Partial<Position> = {}): Position {
  return {
    id: 1, accountId: 1, symbol: "XAUUSD", side: "buy", lots: 0.1,
    entryPrice: 2000, entryTime: 1000, sl: 1990, tp: 2020,
    trailDistance: null, commission: 3, swap: 0, ...over,
  };
}

describe("positionLines", () => {
  it("returns entry, SL and TP", () => {
    const lines = positionLines(pos());
    expect(lines.map((l) => l.kind)).toEqual(["entry", "sl", "tp"]);
  });

  it("marks only SL and TP as draggable", () => {
    // the entry is history: moving it would rewrite a fill that already happened
    const lines = positionLines(pos());
    expect(lines.find((l) => l.kind === "entry")!.draggable).toBe(false);
    expect(lines.find((l) => l.kind === "sl")!.draggable).toBe(true);
    expect(lines.find((l) => l.kind === "tp")!.draggable).toBe(true);
  });

  it("omits a leg that is not set", () => {
    const lines = positionLines(pos({ sl: null }));
    expect(lines.map((l) => l.kind)).toEqual(["entry", "tp"]);
  });

  it("labels with the price", () => {
    const sl = positionLines(pos()).find((l) => l.kind === "sl")!;
    expect(sl.label).toBe("SL 1990.00");
  });
});

describe("hitHandle", () => {
  const lines = positionLines(pos());

  it("finds the handle near the pointer", () => {
    expect(hitHandle(lines, 1990.2, 0.5)!.kind).toBe("sl");
    expect(hitHandle(lines, 2019.9, 0.5)!.kind).toBe("tp");
  });

  it("returns null outside the tolerance", () => {
    expect(hitHandle(lines, 1995, 0.5)).toBeNull();
  });

  it("never returns the entry line", () => {
    // even a direct hit: it is not draggable
    expect(hitHandle(lines, 2000, 0.5)).toBeNull();
  });

  it("picks the nearer of two close handles", () => {
    const tight: PriceLine[] = [
      { kind: "sl", price: 1990, side: "buy", positionId: 1, draggable: true, label: "" },
      { kind: "tp", price: 1992, side: "buy", positionId: 1, draggable: true, label: "" },
    ];
    expect(hitHandle(tight, 1991.8, 5)!.kind).toBe("tp");
    expect(hitHandle(tight, 1990.1, 5)!.kind).toBe("sl");
  });
});

describe("constrainLevel — the direction rules", () => {
  const minD = 0.5;

  it("allows a buy stop below the entry", () => {
    expect(constrainLevel(pos(), "sl", 1980, minD)).toEqual({ price: 1980 });
  });

  it("refuses a buy stop above the entry", () => {
    // this would make the trade a guaranteed instant loss
    const r = constrainLevel(pos(), "sl", 2010, minD);
    expect(r.price).toBeNull();
    expect(r.reason).toContain("below the entry");
  });

  it("refuses a buy stop exactly at the entry", () => {
    expect(constrainLevel(pos(), "sl", 2000, minD).price).toBeNull();
  });

  it("allows a buy target above the entry", () => {
    expect(constrainLevel(pos(), "tp", 2050, minD)).toEqual({ price: 2050 });
  });

  it("refuses a buy target below the entry", () => {
    const r = constrainLevel(pos(), "tp", 1990, minD);
    expect(r.price).toBeNull();
    expect(r.reason).toContain("above the entry");
  });

  it("allows a sell stop above the entry", () => {
    expect(constrainLevel(pos({ side: "sell", sl: 2010, tp: 1980 }), "sl", 2030, minD))
      .toEqual({ price: 2030 });
  });

  it("refuses a sell stop below the entry", () => {
    const r = constrainLevel(pos({ side: "sell", sl: 2010, tp: 1980 }), "sl", 1990, minD);
    expect(r.price).toBeNull();
    expect(r.reason).toContain("above the entry");
  });

  it("allows a sell target below the entry", () => {
    expect(constrainLevel(pos({ side: "sell", sl: 2010, tp: 1980 }), "tp", 1950, minD))
      .toEqual({ price: 1950 });
  });

  it("refuses a sell target above the entry", () => {
    const r = constrainLevel(pos({ side: "sell", sl: 2010, tp: 1980 }), "tp", 2010, minD);
    expect(r.price).toBeNull();
    expect(r.reason).toContain("below the entry");
  });

  it("refuses a non-finite price", () => {
    expect(constrainLevel(pos(), "sl", NaN, minD).price).toBeNull();
  });

  it("honours the minimum distance", () => {
    // with a 5-point buffer, 1996 is too close to a 2000 entry
    expect(constrainLevel(pos(), "sl", 1996, 5).price).toBeNull();
    expect(constrainLevel(pos(), "sl", 1994, 5).price).toBe(1994);
  });
});

describe("risk and reward", () => {
  it("measures distances from the entry", () => {
    const p = pos();
    expect(riskDistance(p)).toBeCloseTo(10, 9);
    expect(rewardDistance(p)).toBeCloseTo(20, 9);
  });

  it("returns 0 when a leg is missing", () => {
    expect(riskDistance(pos({ sl: null }))).toBe(0);
    expect(rewardDistance(pos({ tp: null }))).toBe(0);
  });

  it("computes R as reward over risk", () => {
    expect(currentR(pos())).toBeCloseTo(2, 9);
    expect(currentR(pos({ sl: null }))).toBe(0);
  });

  it("computes profit in R for a long", () => {
    expect(profitInR(pos(), 2010)).toBeCloseTo(1, 9);
    expect(profitInR(pos(), 1995)).toBeCloseTo(-0.5, 9);
  });

  it("computes profit in R for a short", () => {
    const p = pos({ side: "sell", sl: 2010, tp: 1980 });
    expect(profitInR(p, 1990)).toBeCloseTo(1, 9);
    expect(profitInR(p, 2005)).toBeCloseTo(-0.5, 9);
  });

  it("guards against zero risk", () => {
    expect(profitInR(pos({ sl: 2000 }), 2100)).toBe(0);
  });
});

describe("breakEven", () => {
  it("moves the stop to the entry once the trigger is reached", () => {
    const p = pos();
    const d = breakEven(p, 2010, 1);      // exactly 1R
    expect(d.newStop).toBeCloseTo(2000, 9);
  });

  it("does nothing before the trigger", () => {
    const d = breakEven(pos(), 2008, 1);  // 0.8R
    expect(d.newStop).toBeNull();
    expect(d.reason).toContain("needs 1R");
  });

  it("accounts for commission: break-even is not the raw entry", () => {
    // $3 commission on 0.1 lots of gold (10 units) = 0.30 price units
    const d = breakEven(pos(), 2010, 1, 3, 0.1, 100);
    expect(d.newStop).toBeCloseTo(2000.3, 6);
  });

  it("does not move a stop that is already through break-even", () => {
    const p = pos({ sl: 2001 });          // below entry for a buy but in profit
    const d = breakEven(p, 2020, 1);
    expect(d.newStop).toBeNull();
    expect(d.reason).toContain("already");
  });

  it("explains a stop sitting exactly on the entry instead of saying 'zero risk'", () => {
    // a stop at the entry cannot ever trigger a loss, which means it cannot protect
    // anything either: the user needs to know that, not a bare 'zero risk distance'
    const p = pos({ sl: 2000 });
    const d = breakEven(p, 2010, 1);
    expect(d.newStop).toBeNull();
    expect(d.reason).toContain("no risk to manage");
  });

  it("does not move backwards when the stop is in profit", () => {
    const p = pos({ sl: 2005 });          // already locked in +0.5R
    const d = breakEven(p, 2020, 1);
    expect(d.newStop).toBeNull();
  });

  it("refuses with no stop to move", () => {
    expect(breakEven(pos({ sl: null }), 2020, 1).reason).toContain("no stop");
  });

  it("refuses a non-positive trigger", () => {
    expect(breakEven(pos(), 2020, 0).reason).toContain("positive");
  });

  it("works for a short", () => {
    const p = pos({ side: "sell", sl: 2010, tp: 1980 });
    const d = breakEven(p, 1990, 1);
    expect(d.newStop).toBeCloseTo(2000, 9);
  });

  it("accounts for commission on a short in the opposite direction", () => {
    const p = pos({ side: "sell", sl: 2010, tp: 1980 });
    const d = breakEven(p, 1990, 1, 3, 0.1, 100);
    expect(d.newStop).toBeCloseTo(1999.7, 6);
  });
});

describe("applyBreakEven", () => {
  it("returns the price to set, or null", () => {
    expect(applyBreakEven(pos(), 2010, 1)).toBeCloseTo(2000, 9);
    expect(applyBreakEven(pos(), 2005, 1)).toBeNull();
  });
});

describe("describePosition", () => {
  it("summarises side, size, entry and R", () => {
    expect(describePosition(pos(), 2010)).toBe("buy 0.1 @ 2000.00 · +1.00R");
  });

  it("shows a loss with the sign", () => {
    expect(describePosition(pos(), 1995)).toBe("buy 0.1 @ 2000.00 · -0.50R");
  });
});
