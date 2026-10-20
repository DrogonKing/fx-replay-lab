/**
 * Drawing interaction state machine.
 *
 * Pure logic: given a pointer event and the current state, decide what changes.
 * No DOM, no canvas, no chart library — which is why the tricky parts (drag
 * creation, multi-click patterns, snapping, undo) are unit-testable.
 *
 * The renderer feeds it pointer coordinates converted to data space, then draws
 * whatever the resulting Drawing[] says.
 */
import type { Drawing, DrawingKind, Point } from "./drawings.js";
import { hitTest, distanceToSegment } from "./drawings.js";
import {
  pointsNeeded, isDragShape, lineAt, slope, type ShapeKind,
} from "./drawings-ext.js";

export type ToolKind = DrawingKind;

export interface InteractionState {
  /** the active tool, or null when in "select" mode */
  tool: ToolKind | null;
  /** points collected so far for a multi-click shape */
  pending: Point[];
  /** id of the drawing being dragged, if any */
  draggingId: string | null;
  /** which handle of the dragged drawing is moving (-1 = the whole shape) */
  dragHandle: number;
  /** whether the pointer is currently down */
  pressed: boolean;
  /** live preview point while dragging */
  preview: Point | null;
  /** anchor price for hline-style snapping */
  snapPrice: number | null;
}

export function initialState(): InteractionState {
  return {
    tool: null,
    pending: [],
    draggingId: null,
    dragHandle: -1,
    pressed: false,
    preview: null,
    snapPrice: null,
  };
}

export interface PointerContext {
  point: Point;
  /** price tolerance in data units, derived from pixels by the caller */
  tolerance: number;
  timeWeight: number;
  /** id generator so the reducer stays pure */
  nextId: () => string;
  /** default style for new drawings */
  style: { color: string; width: number };
  /** current chart right edge in time, for shapes that extend */
  rightEdge: number;
}

export type InteractionResult = {
  state: InteractionState;
  drawings: Drawing[];
  /** set when a shape was completed this event */
  committed: boolean;
};

/** True when the tool is created by click-drag rather than click-click. */
export function isDragTool(tool: ToolKind): boolean {
  return isDragShape(tool as ShapeKind) || pointsNeeded(tool as ShapeKind) === 1;
}

/**
 * Pointer down.
 *
 * Two very different behaviours live here:
 *  - SELECT mode (tool === null): pick up an existing drawing or start nothing.
 *  - DRAW mode: begin a shape. Drag tools anchor immediately; multi-point tools
 *    accumulate points across separate clicks.
 */
export function onPointerDown(
  state: InteractionState,
  drawings: readonly Drawing[],
  ctx: PointerContext,
): InteractionResult {
  // ---- select / drag existing -------------------------------------------
  if (state.tool === null) {
    const hit = hitTest(drawings, ctx.point, ctx.tolerance, ctx.timeWeight);
    if (!hit) {
      return { state: { ...state, pressed: true, draggingId: null }, drawings: [...drawings], committed: false };
    }
    return {
      state: {
        ...state, pressed: true, draggingId: hit, dragHandle: -1, preview: ctx.point,
      },
      drawings: [...drawings],
      committed: false,
    };
  }

  // ---- draw ---------------------------------------------------------------
  const needed = pointsNeeded(state.tool as ShapeKind);

  if (needed === 1) {
    // single-click shapes commit immediately at the clicked price
    const d: Drawing = {
      id: ctx.nextId(),
      kind: state.tool as DrawingKind,
      points: [ctx.point],
      color: ctx.style.color,
      width: ctx.style.width,
    };
    return {
      state: { ...state, pressed: true, pending: [], preview: ctx.point },
      drawings: [...drawings, d],
      committed: true,
    };
  }

  // two-point drag tool: anchor and drag
  if (isDragTool(state.tool) && needed === 2 && state.pending.length === 0) {
    return {
      state: {
        ...state, pressed: true, pending: [ctx.point], preview: ctx.point,
      },
      drawings: [...drawings],
      committed: false,
    };
  }

  // multi-point click tool: accumulate
  const pending = [...state.pending, ctx.point];
  if (pending.length < needed) {
    return {
      state: { ...state, pressed: true, pending, preview: ctx.point },
      drawings: [...drawings],
      committed: false,
    };
  }

  // complete
  const d: Drawing = {
    id: ctx.nextId(),
    kind: state.tool as DrawingKind,
    points: pending,
    color: ctx.style.color,
    width: ctx.style.width,
  };
  return {
    state: { ...state, pressed: false, pending: [], preview: null },
    drawings: [...drawings, d],
    committed: true,
  };
}

/** Pointer move: update a drag preview or move a dragged drawing. */
export function onPointerMove(
  state: InteractionState,
  drawings: readonly Drawing[],
  ctx: PointerContext,
): InteractionResult {
  // dragging an existing drawing
  if (state.pressed && state.draggingId) {
    const idx = drawings.findIndex((d) => d.id === state.draggingId);
    if (idx < 0) return { state, drawings: [...drawings], committed: false };

    const target = drawings[idx]!;
    const last = state.preview;
    if (!last) {
      return { state: { ...state, preview: ctx.point }, drawings: [...drawings], committed: false };
    }

    // translate the whole shape by the pointer delta
    const dt = ctx.point.time - last.time;
    const dp = ctx.point.price - last.price;
    const moved: Drawing = {
      ...target,
      points: target.points.map((p) => ({
        time: p.time + dt,
        price: p.price + dp,
      })),
    };
    const next = [...drawings];
    next[idx] = moved;
    return {
      state: { ...state, preview: ctx.point },
      drawings: next,
      committed: false,
    };
  }

  // preview while creating
  if (state.pressed && state.pending.length > 0) {
    return {
      state: { ...state, preview: ctx.point },
      drawings: [...drawings],
      committed: false,
    };
  }

  return { state: { ...state, preview: ctx.point }, drawings: [...drawings], committed: false };
}

/** Pointer up: commit a drag-created shape. */
export function onPointerUp(
  state: InteractionState,
  drawings: readonly Drawing[],
  ctx: PointerContext,
): InteractionResult {
  // finish dragging an existing drawing
  if (state.draggingId) {
    return {
      state: { ...state, pressed: false, draggingId: null, preview: null },
      drawings: [...drawings],
      committed: false,
    };
  }

  // finish a drag-created two-point shape
  if (state.pressed && state.pending.length === 1 && state.preview) {
    const a = state.pending[0]!;
    const b = ctx.point;
    // ignore a click that did not actually move: avoids zero-size rectangles
    if (a.time === b.time && a.price === b.price) {
      return {
        state: { ...state, pressed: false, pending: [], preview: null },
        drawings: [...drawings],
        committed: false,
      };
    }
    const d: Drawing = {
      id: ctx.nextId(),
      kind: state.tool as DrawingKind,
      points: [a, b],
      color: ctx.style.color,
      width: ctx.style.width,
    };
    return {
      state: { ...state, pressed: false, pending: [], preview: null },
      drawings: [...drawings, d],
      committed: true,
    };
  }

  return { state: { ...state, pressed: false, preview: null }, drawings: [...drawings], committed: false };
}

/** Escape cancels an in-progress shape and returns to select mode. */
export function onCancel(state: InteractionState, drawings: readonly Drawing[]): InteractionResult {
  return {
    state: { ...initialState(), tool: null },
    drawings: [...drawings],
    committed: false,
  };
}

/** Delete a drawing by id. */
export function onDelete(
  drawings: readonly Drawing[],
  id: string,
): Drawing[] {
  return drawings.filter((d) => d.id !== id);
}

/** Delete the drawing under the pointer, if any. */
export function deleteAt(
  drawings: readonly Drawing[],
  point: Point,
  tolerance: number,
  timeWeight: number,
): { drawings: Drawing[]; removedId: string | null } {
  const hit = hitTest(drawings, point, tolerance, timeWeight);
  if (!hit) return { drawings: [...drawings], removedId: null };
  return { drawings: onDelete(drawings, hit), removedId: hit };
}

/**
 * Translate a finished drawing into the geometry the renderer must draw.
 *
 * Returning a description instead of drawing avoids the renderer needing to know
 * about each tool, and makes it possible to assert in tests that, say, a Fib
 * retracement produces seven levels.
 */
export interface RenderLine {
  from: Point;
  to: Point;
  dashed?: boolean;
  width?: number;
}

export interface RenderLabel {
  at: Point;
  text: string;
}

export interface RenderShape {
  kind: Drawing["kind"];
  id: string;
  color: string;
  width: number;
  lines: RenderLine[];
  labels: RenderLabel[];
  /** filled area between two lines, for channels and position tools */
  fill?: { top: [Point, Point]; bottom: [Point, Point] };
  circle?: { center: Point; radiusPrice: number; radiusTime: number };
}

/**
 * Build render geometry for one drawing.
 *
 * `rightEdge` extends rays and channels to the visible edge so they do not stop
 * mid-screen, which is what makes them read as projections rather than segments.
 */
export function renderDrawing(d: Drawing, rightEdge: number): RenderShape {
  const base: RenderShape = {
    kind: d.kind, id: d.id, color: d.color, width: d.width, lines: [], labels: [],
  };
  const [a, b, c] = d.points;

  switch (d.kind) {
    case "hline":
      if (a) {
        base.lines.push({
          from: { time: a.time, price: a.price },
          to: { time: rightEdge, price: a.price },
        });
        base.labels.push({ at: { time: rightEdge, price: a.price }, text: a.price.toFixed(2) });
      }
      return base;

    case "vline":
      if (a) {
        base.lines.push({
          from: { time: a.time, price: 0 },
          to: { time: a.time, price: Number.MAX_SAFE_INTEGER },
        });
      }
      return base;

    case "ray":
      if (a && b) {
        const end = lineAt(a, b, rightEdge);
        base.lines.push({ from: a, to: { time: rightEdge, price: end } });
      }
      return base;

    case "extended-line":
      if (a && b) {
        base.lines.push({
          from: { time: Math.min(a.time, b.time) - 1e9, price: lineAt(a, b, Math.min(a.time, b.time) - 1e9) },
          to: { time: rightEdge, price: lineAt(a, b, rightEdge) },
        });
      }
      return base;

    case "channel":
      if (a && b && c) {
        base.lines.push({ from: a, to: b });
        const off = c.price - lineAt(a, b, c.time);
        base.lines.push({
          from: { time: a.time, price: a.price + off },
          to: { time: b.time, price: b.price + off },
        });
        base.fill = {
          top: [a, { time: a.time, price: a.price + off }],
          bottom: [b, { time: b.time, price: b.price + off }],
        };
      }
      return base;

    case "rectangle":
    case "rotated-rectangle":
      if (a && b) {
        const t1 = Math.min(a.time, b.time), t2 = Math.max(a.time, b.time);
        const p1 = Math.min(a.price, b.price), p2 = Math.max(a.price, b.price);
        const tl = { time: t1, price: p2 }, tr = { time: t2, price: p2 };
        const bl = { time: t1, price: p1 }, br = { time: t2, price: p1 };
        base.lines.push({ from: tl, to: tr }, { from: tr, to: br }, { from: br, to: bl }, { from: bl, to: tl });
      }
      return base;

    case "ellipse":
    case "circle":
      if (a && b) {
        base.circle = {
          center: { time: (a.time + b.time) / 2, price: (a.price + b.price) / 2 },
          radiusTime: Math.abs(b.time - a.time) / 2,
          radiusPrice: Math.abs(b.price - a.price) / 2,
        };
      }
      return base;

    case "fib-retracement":
    case "fib-extension":
      if (a && b) {
        const levels = d.levels ?? (d.kind === "fib-extension"
          ? [0, 0.618, 1, 1.618, 2.618]
          : [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
        for (const lv of levels) {
          const price = b.price - (b.price - a.price) * lv;
          base.lines.push({
            from: { time: Math.min(a.time, b.time), price },
            to: { time: Math.max(a.time, b.time), price },
          });
          base.labels.push({
            at: { time: Math.max(a.time, b.time), price },
            text: `${lv} (${price.toFixed(2)})`,
          });
        }
      }
      return base;

    case "long-position":
    case "short-position":
      if (a && b) {
        const targetPrice = c ? c.price : b.price;
        base.lines.push(
          { from: { time: a.time, price: a.price }, to: { time: b.time, price: a.price } },
          { from: { time: a.time, price: b.price }, to: { time: b.time, price: b.price }, dashed: true },
          { from: { time: a.time, price: targetPrice }, to: { time: b.time, price: targetPrice }, dashed: true },
        );
        base.fill = {
          top: [{ time: a.time, price: a.price }, { time: b.time, price: a.price }],
          bottom: [{ time: a.time, price: b.price }, { time: b.time, price: b.price }],
        };
        const risk = Math.abs(a.price - b.price);
        const reward = Math.abs(targetPrice - a.price);
        base.labels.push({
          at: { time: b.time, price: a.price },
          text: `R ${risk > 0 ? (reward / risk).toFixed(2) : "0"}`,
        });
      }
      return base;

    case "measure":
      if (a && b) {
        base.lines.push({ from: a, to: b });
        const dP = b.price - a.price;
        const pct = a.price !== 0 ? (dP / a.price) * 100 : 0;
        base.labels.push({
          at: b,
          text: `${dP >= 0 ? "+" : ""}${dP.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`,
        });
      }
      return base;

    case "text":
    case "note":
    case "callout":
      if (a) {
        base.labels.push({ at: a, text: d.text ?? "text" });
      }
      return base;

    default: {
      // every remaining two-point tool draws a segment
      if (a && b) base.lines.push({ from: a, to: b });
      return base;
    }
  }
}

/** Render an in-progress shape (the rubber band) so the user sees what they get. */
export function renderPreview(
  state: InteractionState,
  style: { color: string; width: number },
  rightEdge: number,
): RenderShape | null {
  if (!state.tool || !state.preview) return null;
  const pts = state.pending;
  if (pts.length === 0) return null;

  const draft: Drawing = {
    id: "__preview",
    kind: state.tool as DrawingKind,
    points: [...pts, state.preview],
    color: style.color,
    width: style.width,
    dashed: true,
  };
  return renderDrawing(draft, rightEdge);
}

/** Slope of a finished two-point drawing, used by the trend-angle tool. */
export function drawingSlope(d: Drawing): number {
  const [a, b] = d.points;
  if (!a || !b) return 0;
  return slope(a, b);
}

/** Length in data units, used to reject degenerate drawings. */
export function drawingIsDegenerate(d: Drawing): boolean {
  if (d.points.length < 2) return false;
  const [a, b] = d.points;
  if (!a || !b) return true;
  return a.time === b.time && a.price === b.price;
}

/** Distance from a point to a drawing, exposed for the selection halo. */
/**
 * Distance from a point to a drawing.
 *
 * The single-point kinds MUST be handled before the "no second point" fallback.
 * Checking `!b` first made a vline (which has one point by design) fall into the
 * price-distance branch, so it could never be hovered or deleted: a click 10
 * seconds away measured 999 price units instead of ~0.01.
 */
export function distanceToDrawing(d: Drawing, p: Point, timeWeight: number): number {
  const [a, b] = d.points;
  if (!a) return Infinity;

  // one-point kinds first
  if (d.kind === "hline" || d.kind === "price-label" || d.kind === "horizontal-ray") {
    return Math.abs(p.price - a.price);
  }
  if (d.kind === "vline") {
    return Math.abs(p.time - a.time) * timeWeight;
  }
  if (d.kind === "text" || d.kind === "note" || d.kind === "callout" ||
      d.kind === "flag" || d.kind === "comment" || d.kind === "signpost" ||
      d.kind === "balloon" || d.kind === "arrow-marker") {
    // anchored annotations: hit in a small box around the anchor
    const dt = Math.abs(p.time - a.time) * timeWeight;
    const dp = Math.abs(p.price - a.price);
    return Math.hypot(dt, dp);
  }

  if (!b) return Math.abs(p.price - a.price);
  return distanceToSegment(p, a, b, timeWeight);
}

/** Which drawing is nearest to a point, for hover highlighting. */
export function nearestDrawing(
  drawings: readonly Drawing[],
  p: Point,
  tolerance: number,
  timeWeight: number,
): string | null {
  let best: string | null = null;
  let bestDist = tolerance;
  for (const d of drawings) {
    if (d.locked) continue;
    const dist = distanceToDrawing(d, p, timeWeight);
    if (dist <= bestDist) {
      bestDist = dist;
      best = d.id;
    }
  }
  return best;
}
