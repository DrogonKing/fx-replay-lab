import { describe, it, expect } from "vitest";
import {
  initialState, isDragTool, onPointerDown, onPointerMove, onPointerUp,
  onCancel, onDelete, deleteAt, renderDrawing, renderPreview, drawingSlope,
  drawingIsDegenerate, distanceToDrawing, nearestDrawing,
  type PointerContext, type InteractionState,
} from "../src/core/drawing-interaction.js";
import type { Drawing, Point } from "../src/core/drawings.js";

const P = (time: number, price: number): Point => ({ time, price });

let idSeq = 0;
function ctx(point: Point, over: Partial<PointerContext> = {}): PointerContext {
  return {
    point,
    tolerance: 0.5,
    timeWeight: 1e-6,
    nextId: () => `d${++idSeq}`,
    style: { color: "#f0b90b", width: 2 },
    rightEdge: 10_000,
    ...over,
  };
}

function withTool(tool: InteractionState["tool"]): InteractionState {
  return { ...initialState(), tool };
}

describe("initialState / isDragTool", () => {
  it("starts in select mode", () => {
    expect(initialState().tool).toBeNull();
    expect(initialState().pending).toEqual([]);
  });
  it("classifies drag tools", () => {
    expect(isDragTool("rectangle")).toBe(true);
    expect(isDragTool("hline")).toBe(true);   // one-click commits on down
    expect(isDragTool("trendline")).toBe(true);
    expect(isDragTool("xabcd")).toBe(false);  // 5 separate clicks
  });
});

describe("creating a one-click shape", () => {
  it("commits immediately on pointer down", () => {
    const r = onPointerDown(withTool("hline"), [], ctx(P(100, 2000)));
    expect(r.committed).toBe(true);
    expect(r.drawings).toHaveLength(1);
    expect(r.drawings[0]!.kind).toBe("hline");
    expect(r.drawings[0]!.points[0]).toEqual(P(100, 2000));
  });

  it("does not leave pending points behind", () => {
    const r = onPointerDown(withTool("text"), [], ctx(P(1, 2)));
    expect(r.state.pending).toEqual([]);
  });
});

describe("creating a drag shape", () => {
  it("anchors on down and completes on up", () => {
    let s = withTool("rectangle");
    let drawings: Drawing[] = [];

    const down = onPointerDown(s, drawings, ctx(P(0, 100)));
    s = down.state;
    drawings = down.drawings;
    expect(drawings).toHaveLength(0);       // nothing yet
    expect(s.pending).toHaveLength(1);

    const move = onPointerMove(s, drawings, ctx(P(100, 200)));
    s = move.state;
    expect(move.state.preview).toEqual(P(100, 200));

    const up = onPointerUp(s, drawings, ctx(P(100, 200)));
    expect(up.committed).toBe(true);
    expect(up.drawings).toHaveLength(1);
    expect(up.drawings[0]!.points).toEqual([P(0, 100), P(100, 200)]);
    expect(up.state.pending).toEqual([]);
  });

  it("rejects a zero-size drag so no invisible shape is created", () => {
    const s = onPointerDown(withTool("rectangle"), [], ctx(P(5, 5))).state;
    const up = onPointerUp(s, [], ctx(P(5, 5)));
    expect(up.committed).toBe(false);
    expect(up.drawings).toHaveLength(0);
  });

  it("builds a trendline from the drag", () => {
    const s1 = onPointerDown(withTool("trendline"), [], ctx(P(0, 100))).state;
    const r = onPointerUp(s1, [], ctx(P(500, 150)));
    expect(r.drawings[0]!.kind).toBe("trendline");
    expect(drawingSlope(r.drawings[0]!)).toBeCloseTo(0.1, 9);
  });
});

describe("creating a multi-click pattern", () => {
  it("collects five clicks for XABCD then commits", () => {
    let s = withTool("xabcd");
    let drawings: Drawing[] = [];
    const pts = [P(0, 100), P(1, 200), P(2, 160), P(3, 190), P(4, 115)];

    for (let i = 0; i < pts.length; i++) {
      const r = onPointerDown(s, drawings, ctx(pts[i]!));
      s = r.state;
      drawings = r.drawings;
      if (i < pts.length - 1) {
        expect(r.committed).toBe(false);
        expect(drawings).toHaveLength(0);
        expect(s.pending).toHaveLength(i + 1);
      } else {
        expect(r.committed).toBe(true);
        expect(drawings).toHaveLength(1);
        expect(drawings[0]!.points).toHaveLength(5);
        expect(drawings[0]!.points).toEqual(pts);
      }
    }
  });

  it("clears pending after committing", () => {
    let s = withTool("fib-channel");
    let drawings: Drawing[] = [];
    for (const p of [P(0, 1), P(1, 2), P(2, 3)]) {
      const r = onPointerDown(s, drawings, ctx(p));
      s = r.state;
      drawings = r.drawings;
    }
    expect(s.pending).toEqual([]);
    expect(drawings).toHaveLength(1);
  });
});

describe("selecting and dragging", () => {
  const existing: Drawing = {
    id: "h1", kind: "hline", points: [P(0, 2000)], color: "#fff", width: 2,
  };

  it("picks up a drawing under the pointer in select mode", () => {
    const r = onPointerDown(initialState(), [existing], ctx(P(500, 2000.2)));
    expect(r.state.draggingId).toBe("h1");
  });

  it("does nothing when clicking empty space", () => {
    const r = onPointerDown(initialState(), [existing], ctx(P(500, 3000)));
    expect(r.state.draggingId).toBeNull();
    expect(r.drawings).toHaveLength(1);
  });

  it("translates the whole shape while dragging", () => {
    let s = onPointerDown(initialState(), [existing], ctx(P(500, 2000))).state;
    // move +10 in price and +100 in time
    const move = onPointerMove(s, [existing], ctx(P(600, 2010)));
    expect(move.drawings[0]!.points[0]).toEqual(P(100, 2010));

    // a second move continues from the new preview, not from the original point
    s = move.state;
    const move2 = onPointerMove(s, move.drawings, ctx(P(700, 2020)));
    expect(move2.drawings[0]!.points[0]).toEqual(P(200, 2020));
  });

  it("releases on pointer up", () => {
    const s = onPointerDown(initialState(), [existing], ctx(P(500, 2000))).state;
    const up = onPointerUp(s, [existing], ctx(P(500, 2000)));
    expect(up.state.draggingId).toBeNull();
    expect(up.state.pressed).toBe(false);
  });
});

describe("cancel / delete", () => {
  it("escape returns to select mode and drops pending points", () => {
    const s = onPointerDown(withTool("xabcd"), [], ctx(P(0, 1))).state;
    const c = onCancel(s, []);
    expect(c.state.tool).toBeNull();
    expect(c.state.pending).toEqual([]);
  });

  it("deletes by id", () => {
    const d: Drawing = { id: "a", kind: "hline", points: [P(0, 1)], color: "#fff", width: 1 };
    expect(onDelete([d], "a")).toEqual([]);
    expect(onDelete([d], "nope")).toHaveLength(1);
  });

  it("deletes the drawing under the pointer", () => {
    const d: Drawing = { id: "a", kind: "hline", points: [P(0, 100)], color: "#fff", width: 1 };
    const r = deleteAt([d], P(5, 100.1), 0.5, 1e-6);
    expect(r.removedId).toBe("a");
    expect(r.drawings).toHaveLength(0);
  });

  it("removes nothing when the pointer hits nothing", () => {
    const d: Drawing = { id: "a", kind: "hline", points: [P(0, 100)], color: "#fff", width: 1 };
    const r = deleteAt([d], P(5, 900), 0.5, 1e-6);
    expect(r.removedId).toBeNull();
  });
});

describe("renderDrawing", () => {
  it("extends an hline to the right edge", () => {
    const d: Drawing = { id: "h", kind: "hline", points: [P(100, 2000)], color: "#fff", width: 2 };
    const g = renderDrawing(d, 5000);
    expect(g.lines).toHaveLength(1);
    expect(g.lines[0]!.from).toEqual(P(100, 2000));
    expect(g.lines[0]!.to.time).toBe(5000);
    expect(g.labels[0]!.text).toBe("2000.00");
  });

  it("projects a ray to the right edge along its slope", () => {
    const d: Drawing = {
      id: "r", kind: "ray", points: [P(0, 100), P(1000, 200)], color: "#fff", width: 2,
    };
    const g = renderDrawing(d, 2000);
    expect(g.lines[0]!.to.price).toBeCloseTo(300, 9);
  });

  it("draws a channel as two parallel lines plus a fill", () => {
    const d: Drawing = {
      id: "c", kind: "channel",
      points: [P(0, 100), P(1000, 200), P(500, 400)],
      color: "#fff", width: 2,
    };
    const g = renderDrawing(d, 2000);
    expect(g.lines).toHaveLength(2);
    expect(g.fill).toBeDefined();
  });

  it("draws four edges for a rectangle", () => {
    const d: Drawing = {
      id: "r", kind: "rectangle", points: [P(100, 200), P(0, 100)], color: "#fff", width: 2,
    };
    const g = renderDrawing(d, 2000);
    expect(g.lines).toHaveLength(4);
  });

  it("emits seven fib levels by default", () => {
    const d: Drawing = {
      id: "f", kind: "fib-retracement", points: [P(0, 100), P(1000, 200)],
      color: "#fff", width: 2,
    };
    const g = renderDrawing(d, 2000);
    expect(g.lines).toHaveLength(7);
    expect(g.labels).toHaveLength(7);
  });

  it("honours custom fib levels", () => {
    const d: Drawing = {
      id: "f", kind: "fib-retracement", points: [P(0, 100), P(1000, 200)],
      color: "#fff", width: 2, levels: [0.5],
    };
    expect(renderDrawing(d, 2000).lines).toHaveLength(1);
  });

  it("draws an ellipse as a circle primitive, not lines", () => {
    const d: Drawing = {
      id: "e", kind: "ellipse", points: [P(0, 100), P(1000, 200)], color: "#fff", width: 2,
    };
    const g = renderDrawing(d, 2000);
    expect(g.circle).toBeDefined();
    expect(g.circle!.center).toEqual(P(500, 150));
    expect(g.lines).toHaveLength(0);
  });

  it("reports R multiple on a position tool", () => {
    const d: Drawing = {
      id: "p", kind: "long-position",
      points: [P(0, 2000), P(10, 1990), P(20, 2030)],
      color: "#fff", width: 2,
    };
    const g = renderDrawing(d, 2000);
    expect(g.labels.some((l) => l.text === "R 3.00")).toBe(true);
  });

  it("shows absolute and percent change on the measure tool", () => {
    const d: Drawing = {
      id: "m", kind: "measure", points: [P(0, 100), P(60, 150)], color: "#fff", width: 2,
    };
    const g = renderDrawing(d, 2000);
    expect(g.labels[0]!.text).toBe("+50.00 (+50.00%)");
  });

  it("does not crash on a drawing with missing points", () => {
    const d: Drawing = { id: "x", kind: "trendline", points: [], color: "#fff", width: 2 };
    expect(() => renderDrawing(d, 1000)).not.toThrow();
  });
});

describe("renderPreview", () => {
  it("returns null in select mode", () => {
    expect(renderPreview(initialState(), { color: "#fff", width: 1 }, 1000)).toBeNull();
  });

  it("returns null before the first click", () => {
    const s = withTool("rectangle");
    expect(renderPreview(s, { color: "#fff", width: 1 }, 1000)).toBeNull();
  });

  it("rubber-bands from the anchor to the pointer", () => {
    const s = onPointerDown(withTool("rectangle"), [], ctx(P(0, 100))).state;
    const s2 = onPointerMove(s, [], ctx(P(50, 150))).state;
    const g = renderPreview(s2, { color: "#f0b90b", width: 2 }, 1000);
    expect(g).not.toBeNull();
    expect(g!.lines.length).toBeGreaterThan(0);
  });
});

describe("helpers", () => {
  it("detects degenerate drawings", () => {
    expect(drawingIsDegenerate({ id: "a", kind: "trendline", points: [P(1, 1), P(1, 1)], color: "#fff", width: 1 })).toBe(true);
    expect(drawingIsDegenerate({ id: "a", kind: "trendline", points: [P(1, 1), P(2, 1)], color: "#fff", width: 1 })).toBe(false);
    expect(drawingIsDegenerate({ id: "a", kind: "hline", points: [P(1, 1)], color: "#fff", width: 1 })).toBe(false);
  });

  it("measures distance to each kind", () => {
    const h: Drawing = { id: "h", kind: "hline", points: [P(0, 100)], color: "#fff", width: 1 };
    expect(distanceToDrawing(h, P(99, 100.5), 1e-6)).toBeCloseTo(0.5, 9);

    const v: Drawing = { id: "v", kind: "vline", points: [P(1000, 0)], color: "#fff", width: 1 };
    expect(distanceToDrawing(v, P(1010, 999), 1e-3)).toBeCloseTo(0.01, 6);
  });

  it("finds the nearest drawing for hover", () => {
    const a: Drawing = { id: "a", kind: "hline", points: [P(0, 100)], color: "#fff", width: 1 };
    const b: Drawing = { id: "b", kind: "hline", points: [P(0, 200)], color: "#fff", width: 1 };
    expect(nearestDrawing([a, b], P(0, 199.8), 0.5, 1e-6)).toBe("b");
    expect(nearestDrawing([a, b], P(0, 500), 0.5, 1e-6)).toBeNull();
  });

  it("skips locked drawings when hovering", () => {
    const a: Drawing = {
      id: "a", kind: "hline", points: [P(0, 100)], color: "#fff", width: 1, locked: true,
    };
    expect(nearestDrawing([a], P(0, 100), 0.5, 1e-6)).toBeNull();
  });
});
