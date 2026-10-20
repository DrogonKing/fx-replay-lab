import { describe, it, expect } from "vitest";
import {
  pointsNeeded, isDragShape, lineAt, slope, angleDegrees, pointAtAngle,
  channelParallel, pitchfork, ellipseBounds, pointInEllipse, polygonPoints,
  FIB_RETRACEMENT_LEVELS, FIB_EXTENSION_LEVELS, fibLevels, fibTimeZones,
  fibChannel, GANN_ANGLES, gannFan, xabcdRatios, elliottImpulseCheck,
  measure, positionMetrics,
} from "../src/core/drawings-ext.js";
import type { Point } from "../src/core/drawings.js";

const P = (time: number, price: number): Point => ({ time, price });

describe("pointsNeeded", () => {
  it("knows anchored one-click shapes", () => {
    expect(pointsNeeded("hline")).toBe(1);
    expect(pointsNeeded("text")).toBe(1);
    expect(pointsNeeded("price-label")).toBe(1);
  });
  it("knows two-point shapes", () => {
    expect(pointsNeeded("trendline")).toBe(2);
    expect(pointsNeeded("rectangle")).toBe(2);
    expect(pointsNeeded("fib-retracement")).toBe(2);
    expect(pointsNeeded("measure")).toBe(2);
  });
  it("knows three-point shapes", () => {
    expect(pointsNeeded("pitchfork")).toBe(3);
    expect(pointsNeeded("gann-fan")).toBe(3);
    expect(pointsNeeded("triangle")).toBe(3);
  });
  it("knows multi-point patterns", () => {
    expect(pointsNeeded("xabcd")).toBe(5);
    expect(pointsNeeded("head-shoulders")).toBe(5);
    expect(pointsNeeded("cypher")).toBe(6);
    expect(pointsNeeded("elliott-impulse")).toBe(6);
  });
});

describe("isDragShape", () => {
  it("separates drag-to-create from click-anchored", () => {
    expect(isDragShape("rectangle")).toBe(true);
    expect(isDragShape("ellipse")).toBe(true);
    expect(isDragShape("measure")).toBe(true);
    expect(isDragShape("hline")).toBe(false);
    expect(isDragShape("text")).toBe(false);
  });
});

describe("line math", () => {
  const a = P(0, 100);
  const b = P(1000, 200);

  it("extrapolates along the line", () => {
    expect(lineAt(a, b, 500)).toBeCloseTo(150, 9);
    expect(lineAt(a, b, 2000)).toBeCloseTo(300, 9);
    expect(lineAt(a, b, -1000)).toBeCloseTo(0, 9);
  });

  it("computes slope in price per second", () => {
    expect(slope(a, b)).toBeCloseTo(0.1, 12);
  });

  it("handles a zero-width line without dividing by zero", () => {
    expect(slope(a, P(0, 999))).toBe(0);
    expect(lineAt(a, P(0, 999), 5000)).toBe(100);
  });

  it("computes angle in screen space, not data space", () => {
    // with pxPerSec=1 and pxPerPrice=1, a 45-degree line has equal deltas
    const ang = angleDegrees(P(0, 0), P(100, 100), 1, 1);
    expect(ang).toBeCloseTo(45, 9);
    // doubling the price scale steepens the angle
    const steeper = angleDegrees(P(0, 0), P(100, 100), 1, 2);
    expect(steeper).toBeGreaterThan(ang);
  });

  it("solves a point at a target angle and round-trips", () => {
    const target = 30;
    const solved = pointAtAngle(P(0, 0), P(1000, 500), target, 1, 1);
    expect(angleDegrees(P(0, 0), solved, 1, 1)).toBeCloseTo(target, 6);
  });
});

describe("channel", () => {
  it("builds a parallel line through the third point", () => {
    const a = P(0, 100);
    const b = P(1000, 200);
    const c = P(500, 400);   // 250 above the base line at t=500
    const [p1, p2] = channelParallel(a, b, c);
    // offset is +250, so the parallel starts 250 above a
    expect(p1.price).toBeCloseTo(350, 9);
    expect(p2.price).toBeCloseTo(450, 9);
    // the parallel must have the same slope as the base
    expect(slope(p1, p2)).toBeCloseTo(slope(a, b), 12);
    // and must pass through c
    expect(lineAt(p1, p2, c.time)).toBeCloseTo(c.price, 9);
  });
});

describe("pitchfork", () => {
  it("median passes through the pivot and the midpoint of B and C", () => {
    const pivotPt = P(0, 100);
    const b = P(1000, 200);
    const c = P(2000, 300);
    const g = pitchfork(pivotPt, b, c);
    // midpoint of B(1000,200) and C(2000,300) is t=1500, price=250
    const mid = { time: 1500, price: 250 };
    expect(lineAt(g.median[0], g.median[1], mid.time)).toBeCloseTo(mid.price, 9);
  });

  it("parallels run through B and C with the median's slope", () => {
    const g = pitchfork(P(0, 100), P(1000, 200), P(2000, 100));
    const medSlope = slope(g.median[0], g.median[1]);
    expect(slope(g.upper[0], g.upper[1])).toBeCloseTo(medSlope, 12);
    expect(slope(g.lower[0], g.lower[1])).toBeCloseTo(medSlope, 12);
    // and the parallels actually start at B and C
    expect(g.upper[0]).toEqual(P(1000, 200));
    expect(g.lower[0]).toEqual(P(2000, 100));
  });

  it("never collapses a parallel to zero length", () => {
    // regression: endTime was derived as max(b.time, c.time), so when C was the
    // rightmost point the lower parallel had start == end and vanished.
    const g = pitchfork(P(0, 100), P(100, 200), P(900, 150));
    for (const seg of [g.median, g.upper, g.lower]) {
      expect(seg[1].time).toBeGreaterThan(seg[0].time);
      expect(Number.isFinite(seg[1].price)).toBe(true);
    }
  });

  it("honours an explicit right edge", () => {
    const g = pitchfork(P(0, 100), P(100, 200), P(900, 150), 5000);
    for (const seg of [g.median, g.upper, g.lower]) {
      expect(seg[1].time).toBe(5000);
    }
  });
});

describe("ellipse", () => {
  it("normalises corners regardless of drag direction", () => {
    const e = ellipseBounds(P(100, 10), P(0, 0));
    expect(e.tMin).toBe(0);
    expect(e.tMax).toBe(100);
    expect(e.pMin).toBe(0);
    expect(e.pMax).toBe(10);
    expect(e.cx).toBe(50);
    expect(e.cy).toBe(5);
    expect(e.rx).toBe(50);
    expect(e.ry).toBe(5);
  });

  it("hit-tests inside and outside", () => {
    const a = P(0, 0);
    const b = P(100, 100);
    expect(pointInEllipse(P(50, 50), a, b)).toBe(true);      // centre
    expect(pointInEllipse(P(2, 2), a, b)).toBe(false);       // corner, outside the ellipse
  });

  it("returns false for a degenerate ellipse instead of dividing by zero", () => {
    expect(pointInEllipse(P(0, 0), P(0, 0), P(0, 0))).toBe(false);
  });
});

describe("polygonPoints", () => {
  it("produces the requested number of vertices", () => {
    expect(polygonPoints(P(0, 0), P(100, 100), 3)).toHaveLength(3);
    expect(polygonPoints(P(0, 0), P(100, 100), 6)).toHaveLength(6);
  });

  it("places vertices on the ellipse boundary", () => {
    const [a, b] = [P(0, 0), P(100, 100)];
    const e = ellipseBounds(a, b);
    for (const v of polygonPoints(a, b, 5)) {
      const dx = (v.time - e.cx) / e.rx;
      const dy = (v.price - e.cy) / e.ry;
      expect(dx * dx + dy * dy).toBeCloseTo(1, 9);
    }
  });
});

describe("fibonacci", () => {
  const a = P(0, 100);
  const b = P(1000, 200);

  it("retracement 0 is the end, 1 is the start", () => {
    const lv = fibLevels(a, b, FIB_RETRACEMENT_LEVELS);
    expect(lv[0]!.level).toBe(0);
    expect(lv[0]!.price).toBeCloseTo(200, 9);
    expect(lv[lv.length - 1]!.price).toBeCloseTo(100, 9);
  });

  it("0.618 sits at the classic ratio", () => {
    const lv = fibLevels(a, b, [0.618]);
    expect(lv[0]!.price).toBeCloseTo(200 - 100 * 0.618, 9);
  });

  it("extensions go beyond the impulse", () => {
    const lv = fibLevels(a, b, FIB_EXTENSION_LEVELS);
    const at1618 = lv.find((l) => l.level === 1.618)!;
    expect(at1618.price).toBeCloseTo(200 - 100 * 1.618, 9);
    expect(at1618.price).toBeLessThan(100);   // beyond the origin
  });

  it("time zones scale the a->b time span", () => {
    const tz = fibTimeZones(a, b, [0, 0.5, 1, 1.618]);
    expect(tz[0]!.time).toBe(0);
    expect(tz[1]!.time).toBe(500);
    expect(tz[2]!.time).toBe(1000);
    expect(tz[3]!.time).toBeCloseTo(1618, 6);
  });

  it("channel levels are parallel offsets anchored on the third point", () => {
    const c = P(500, 400);
    const ch = fibChannel(a, b, c, [0, 1]);
    // level 0 is the base line itself
    expect(ch[0]!.points[0].price).toBeCloseTo(100, 9);
    // level 1 passes through c's offset (400 - 150 = 250 above base)
    expect(lineAt(ch[1]!.points[0], ch[1]!.points[1], c.time)).toBeCloseTo(c.price, 9);
    // and keeps the base slope
    expect(slope(ch[1]!.points[0], ch[1]!.points[1])).toBeCloseTo(slope(a, b), 12);
  });
});

describe("gann fan", () => {
  it("emits one ray per canonical angle", () => {
    const rays = gannFan(P(0, 100), P(1000, 100), 1, 1, 1000);
    expect(rays).toHaveLength(GANN_ANGLES.length);
    expect(rays.map((r) => r.angle)).toEqual(GANN_ANGLES);
  });

  it("steeper angles produce higher endpoints", () => {
    const rays = gannFan(P(0, 100), P(1000, 100), 1, 1, 1000);
    const prices = rays.map((r) => r.end.price);
    for (let i = 1; i < prices.length; i++) {
      expect(prices[i]!).toBeGreaterThan(prices[i - 1]!);
    }
  });
});

describe("xabcd pattern", () => {
  // a textbook bullish XABCD: X low, A high, B pullback, C lower, D lowest
  const good = [P(0, 100), P(1, 200), P(2, 160), P(3, 190), P(4, 115)];

  it("computes the leg ratios", () => {
    const r = xabcdRatios(good)!;
    // X=100 A=200 B=160 C=190 D=115
    expect(r.ab).toBeCloseTo(40 / 100, 6);        // AB/XA = 40/100
    expect(r.bc).toBeCloseTo(30 / 40, 6);         // BC/AB = 30/40
    expect(r.cd).toBeCloseTo(75 / 30, 6);         // CD/BC = 75/30
    expect(r.ad).toBeCloseTo(85 / 100, 6);        // AD/XA = 85/100 
  });

  it("validates a textbook pattern", () => {
    const r = xabcdRatios(good)!;
    expect(r.valid).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it("rejects a pattern whose AD is out of the 0.786-0.886 band", () => {
    // D only reaches 1.5/100 = 0.015 retracement, far too shallow
    const bad = [P(0, 100), P(1, 200), P(2, 160), P(3, 190), P(4, 198)];
    const r = xabcdRatios(bad)!;
    expect(r.valid).toBe(false);
    expect(r.problems.some((p) => p.includes("AD/XA"))).toBe(true);
  });

  it("returns null with too few points", () => {
    expect(xabcdRatios([P(0, 1)])).toBeNull();
  });

  it("does not divide by zero on a flat pattern", () => {
    const flat = [P(0, 100), P(1, 100), P(2, 100), P(3, 100), P(4, 100)];
    const r = xabcdRatios(flat)!;
    expect(Number.isFinite(r.ab)).toBe(true);
    expect(r.valid).toBe(false);
  });
});

describe("elliott impulse", () => {
  const good = [P(0, 100), P(1, 150), P(2, 120), P(3, 220), P(4, 190), P(5, 260)];

  it("accepts a textbook impulse", () => {
    expect(elliottImpulseCheck(good)).toEqual([]);
  });

  it("flags wave 3 being the shortest", () => {
    const bad = [P(0, 100), P(1, 200), P(2, 150), P(3, 160), P(4, 140), P(5, 300)];
    // w1=100, w3=10, w5=160 -> w3 shortest
    const problems = elliottImpulseCheck(bad);
    expect(problems.some((p) => p.includes("wave 3"))).toBe(true);
  });

  it("flags wave 2 retracing past the start", () => {
    const bad = [P(0, 100), P(1, 200), P(2, 90), P(3, 260), P(4, 210), P(5, 300)];
    expect(elliottImpulseCheck(bad).some((p) => p.includes("wave 2"))).toBe(true);
  });

  it("asks for more points instead of throwing", () => {
    expect(elliottImpulseCheck([P(0, 1)])[0]).toContain("needs 6 points");
  });
});

describe("measure tool", () => {
  it("reports delta, percent and direction", () => {
    const m = measure(P(0, 100), P(3600, 150));
    expect(m.priceDelta).toBeCloseTo(50, 9);
    expect(m.percent).toBeCloseTo(50, 9);
    expect(m.seconds).toBe(3600);
    expect(m.up).toBe(true);
  });

  it("handles a falling measurement", () => {
    const m = measure(P(0, 200), P(60, 100));
    expect(m.priceDelta).toBeCloseTo(-100, 9);
    expect(m.percent).toBeCloseTo(-50, 9);
    expect(m.up).toBe(false);
  });

  it("does not divide by zero when starting at 0", () => {
    expect(measure(P(0, 0), P(10, 5)).percent).toBe(0);
  });
});

describe("position metrics", () => {
  it("computes risk, reward, R and money at a lot size", () => {
    const m = positionMetrics("long-position", P(0, 2000), P(10, 1990), P(20, 2030));
    expect(m.side).toBe("long");
    expect(m.risk).toBeCloseTo(10, 9);
    expect(m.reward).toBeCloseTo(30, 9);
    expect(m.rMultiple).toBeCloseTo(3, 9);
    // 0.10 lots on gold (contract 100): risk = 10 * 0.10 * 100 = $100
    expect(m.riskMoney(0.10, 100)).toBeCloseTo(100, 9);
    expect(m.rewardMoney(0.10, 100)).toBeCloseTo(300, 9);
  });

  it("works for a short with the target below", () => {
    const m = positionMetrics("short-position", P(0, 2000), P(10, 2010), P(20, 1970));
    expect(m.side).toBe("short");
    expect(m.risk).toBeCloseTo(10, 9);
    expect(m.rMultiple).toBeCloseTo(3, 9);
  });

  it("has no reward when no target is set", () => {
    const m = positionMetrics("long-position", P(0, 2000), P(10, 1990));
    expect(m.target).toBeNull();
    expect(m.reward).toBe(0);
    expect(m.rMultiple).toBe(0);
  });

  it("does not divide by zero when stop equals entry", () => {
    const m = positionMetrics("long-position", P(0, 2000), P(10, 2000));
    expect(m.rMultiple).toBe(0);
  });
});
