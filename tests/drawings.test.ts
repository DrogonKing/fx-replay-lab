import { describe, it, expect } from "vitest";
import {
  requiredPoints, distanceToSegment, distanceToRay, pointInRect, hitTest,
  fibPrice, fibExtensionPrice, channelOffset, positionGeometry, DrawingHistory,
  FIB_LEVELS,
} from "../src/core/drawings.js";
import type { Drawing } from "../src/core/drawings.js";

const P = (time: number, price: number) => ({ time, price });

describe("requiredPoints", () => {
  it("knows how many clicks each tool needs", () => {
    expect(requiredPoints("hline")).toBe(1);
    expect(requiredPoints("trendline")).toBe(2);
    expect(requiredPoints("channel")).toBe(3);
    expect(requiredPoints("long-position")).toBe(2);
  });
});

describe("distanceToSegment", () => {
  const a = P(0, 0);
  const b = P(1000, 10);

  it("is zero on the line", () => {
    // midpoint
    expect(distanceToSegment(P(500, 5), a, b, 1)).toBeCloseTo(0, 9);
  });

  it("measures PERPENDICULAR distance, not vertical distance", () => {
    // The segment runs (0,0)->(1000,10), i.e. y = 0.01x. From (500,8):
    //   vertical gap = |5 - 8| = 3
    //   perpendicular = 3 / sqrt(0.01^2 + 1) = 2.9998500112...
    // Asserting 3 would be wrong: it silently assumes a horizontal line.
    const expected = 3 / Math.sqrt(0.01 * 0.01 + 1);
    expect(distanceToSegment(P(500, 8), a, b, 1)).toBeCloseTo(expected, 9);

    // and the perpendicular is always <= the vertical gap
    expect(distanceToSegment(P(500, 8), a, b, 1)).toBeLessThan(3);
  });

  it("is exactly the vertical gap for a horizontal line", () => {
    const h0 = P(0, 10);
    const h1 = P(1000, 10);
    expect(distanceToSegment(P(500, 13), h0, h1, 1)).toBeCloseTo(3, 9);
  });

  it("clamps beyond the endpoints", () => {
    // far past b: distance to the endpoint b
    const d = distanceToSegment(P(2000, 10), a, b, 1);
    expect(d).toBeCloseTo(1000, 6);
  });
});

describe("distanceToRay", () => {
  it("extends forward, not backward", () => {
    const a = P(0, 0);
    const b = P(100, 10);
    // on the forward extension: y = 0.1x -> at x=1000, y=100
    expect(distanceToRay(P(1000, 100), a, b, 1)).toBeCloseTo(0, 6);
    // behind the origin, measured from a
    expect(distanceToRay(P(-100, 0), a, b, 1)).toBeCloseTo(100, 6);
  });
});

describe("pointInRect", () => {
  it("works regardless of corner order", () => {
    const a = P(100, 10);
    const b = P(0, 0);
    expect(pointInRect(P(50, 5), a, b)).toBe(true);
    expect(pointInRect(P(150, 5), a, b)).toBe(false);
  });
});

describe("hitTest", () => {
  const hline: Drawing = {
    id: "h1", kind: "hline", points: [P(0, 100)], color: "#fff", width: 1,
  };
  const trend: Drawing = {
    id: "t1", kind: "trendline", points: [P(0, 0), P(1000, 10)], color: "#fff", width: 1,
  };

  it("finds an hline within tolerance", () => {
    expect(hitTest([hline], P(500, 100.2), 0.5, 1)).toBe("h1");
    expect(hitTest([hline], P(500, 105), 0.5, 1)).toBeNull();
  });

  it("finds a trendline near the segment", () => {
    expect(hitTest([trend], P(500, 5.2), 0.5, 1)).toBe("t1");
  });

  it("prefers the topmost (most recent) drawing", () => {
    const top: Drawing = { ...hline, id: "h2" };
    expect(hitTest([hline, top], P(500, 100), 0.5, 1)).toBe("h2");
  });

  it("skips locked drawings", () => {
    expect(hitTest([{ ...hline, locked: true }], P(500, 100), 0.5, 1)).toBeNull();
  });

  it("hits a rectangle border but not its interior", () => {
    const rect: Drawing = {
      id: "r1", kind: "rectangle",
      points: [P(0, 0), P(100, 10)], color: "#fff", width: 1,
    };
    // on the top edge
    expect(hitTest([rect], P(50, 10), 0.5, 1)).toBe("r1");
    // dead centre, away from every edge
    expect(hitTest([rect], P(50, 5), 0.5, 1)).toBeNull();
  });

  it("hits a vertical line by time", () => {
    const v: Drawing = {
      id: "v1", kind: "vline", points: [P(1000, 0)], color: "#fff", width: 1,
    };
    expect(hitTest([v], P(1000, 999), 0.5, 1e-3)).toBe("v1");
  });
});

describe("fibonacci", () => {
  const a = P(0, 100);
  const b = P(100, 200);

  it("level 0 is the impulse end and 1.0 is the start", () => {
    expect(fibPrice(a, b, 0)).toBeCloseTo(200, 9);
    expect(fibPrice(a, b, 1)).toBeCloseTo(100, 9);
  });

  it("0.5 is halfway", () => {
    expect(fibPrice(a, b, 0.5)).toBeCloseTo(150, 9);
  });

  it("has the classic level set", () => {
    expect(FIB_LEVELS).toContain(0.618);
    expect(FIB_LEVELS[0]).toBe(0);
  });

  it("extensions go beyond the impulse", () => {
    expect(fibExtensionPrice(a, b, 1.618)).toBeCloseTo(100 + 100 * 1.618, 9);
  });
});

describe("channelOffset", () => {
  it("computes the parallel displacement from the third point", () => {
    // a-b is a 45-degree-ish line; c sits 5 above it
    const d: Drawing = {
      id: "c1", kind: "channel",
      points: [P(0, 0), P(100, 10), P(50, 10)],
      color: "#fff", width: 1,
    };
    // slope = 0.1; expected at t=50 is 5; c.price=10 -> offset 5
    expect(channelOffset(d)).toBeCloseTo(5, 9);
  });

  it("returns null when a point is missing", () => {
    const d: Drawing = {
      id: "c2", kind: "channel", points: [P(0, 0), P(100, 10)],
      color: "#fff", width: 1,
    };
    expect(channelOffset(d)).toBeNull();
  });
});

describe("positionGeometry", () => {
  it("computes risk, reward and R multiple for a long", () => {
    const d: Drawing = {
      id: "lp", kind: "long-position",
      points: [P(0, 100), P(10, 95), P(20, 115)],
      color: "#fff", width: 1,
    };
    const g = positionGeometry(d)!;
    expect(g.side).toBe("long");
    expect(g.risk).toBeCloseTo(5, 9);
    expect(g.reward).toBeCloseTo(15, 9);
    expect(g.rMultiple).toBeCloseTo(3, 9);
  });

  it("handles a short", () => {
    const d: Drawing = {
      id: "sp", kind: "short-position",
      points: [P(0, 100), P(10, 105), P(20, 90)],
      color: "#fff", width: 1,
    };
    const g = positionGeometry(d)!;
    expect(g.side).toBe("short");
    expect(g.risk).toBeCloseTo(5, 9);
    expect(g.rMultiple).toBeCloseTo(2, 9);
  });

  it("does not divide by zero when stop == entry", () => {
    const d: Drawing = {
      id: "z", kind: "long-position",
      points: [P(0, 100), P(10, 100)],
      color: "#fff", width: 1,
    };
    expect(positionGeometry(d)!.rMultiple).toBe(0);
  });
});

describe("DrawingHistory", () => {
  const mk = (id: string): Drawing => ({
    id, kind: "hline", points: [P(0, 1)], color: "#fff", width: 1,
  });

  it("undoes and redoes", () => {
    const h = new DrawingHistory();
    h.commit([mk("a")]);
    h.commit([mk("a"), mk("b")]);
    expect(h.get()).toHaveLength(2);
    expect(h.undo()).toHaveLength(1);
    expect(h.undo()).toHaveLength(0);
    expect(h.redo()).toHaveLength(1);
    expect(h.canUndo()).toBe(true);
    expect(h.canRedo()).toBe(true);
  });

  it("clears the redo stack on a new commit", () => {
    const h = new DrawingHistory();
    h.commit([mk("a")]);
    h.undo();
    h.commit([mk("b")]);
    expect(h.canRedo()).toBe(false);
  });

  it("respects the history limit", () => {
    const h = new DrawingHistory(3);
    for (let i = 0; i < 10; i++) h.commit([mk(String(i))]);
    let depth = 0;
    while (h.canUndo()) { h.undo(); depth++; }
    expect(depth).toBe(3);
  });

  it("reset clears both stacks", () => {
    const h = new DrawingHistory();
    h.commit([mk("a")]);
    h.reset([mk("x")]);
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
    expect(h.get()).toHaveLength(1);
  });
});
