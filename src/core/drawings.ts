/**
 * Drawing model and hit-testing.
 *
 * Drawings live in core (not the renderer) for three reasons: they must persist
 * per symbol, they must be undoable, and their geometry needs tests. The renderer
 * only converts these shapes to chart primitives.
 *
 * Coordinates are in DATA space (time, price), never pixels, so a drawing stays
 * correct across zoom, timeframe change and window resize.
 */

export type DrawingKind =
  | "trendline"
  | "hline"
  | "vline"
  | "ray"
  | "rectangle"
  | "fib-retracement"
  | "fib-extension"
  | "channel"
  | "text"
  | "long-position"
  | "short-position";

export interface Point {
  /** UTC epoch seconds */
  time: number;
  price: number;
}

export interface Drawing {
  id: string;
  kind: DrawingKind;
  /** 1 point for hline/vline/text, 2 for the rest, 3 for channel */
  points: Point[];
  color: string;
  width: number;
  /** dashed style for projection lines */
  dashed?: boolean;
  /** text content for kind "text" */
  text?: string;
  /** fib levels to render; defaults to the classic set */
  levels?: number[];
  /** locked drawings are not hit-tested for dragging */
  locked?: boolean;
  /** optional per-drawing opacity 0..1 */
  opacity?: number;
}

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
export const FIB_EXT_LEVELS = [0, 0.618, 1, 1.618, 2.618];

/** Required number of points for a kind, or 0 when it varies. */
export function requiredPoints(kind: DrawingKind): number {
  switch (kind) {
    case "hline":
    case "vline":
    case "text":
      return 1;
    case "channel":
      return 3;
    default:
      return 2;
  }
}

/**
 * Distance from point p to the SEGMENT ab, in price/time space.
 *
 * Time is in seconds and price in quote units, so the two axes are not
 * comparable directly. The caller supplies `timeWeight` (price units per second)
 * so a click tolerance behaves the same at any zoom: 1e-6 means one second is
 * worth a millionth of a price point, which is roughly how a chart looks when
 * 1 day spans ~2000 px and 1 price point spans ~2 px.
 */
export function distanceToSegment(
  p: Point, a: Point, b: Point, timeWeight = 1e-6,
): number {
  const ax = a.time * timeWeight, ay = a.price;
  const bx = b.time * timeWeight, by = b.price;
  const px = p.time * timeWeight, py = p.price;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Distance to an infinite ray starting at a through b. */
export function distanceToRay(
  p: Point, a: Point, b: Point, timeWeight = 1e-6,
): number {
  const ax = a.time * timeWeight, ay = a.price;
  const bx = b.time * timeWeight, by = b.price;
  const px = p.time * timeWeight, py = p.price;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, t);     // ray: never backwards
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** True when a point is inside an axis-aligned rectangle defined by two corners. */
export function pointInRect(p: Point, a: Point, b: Point): boolean {
  const tMin = Math.min(a.time, b.time), tMax = Math.max(a.time, b.time);
  const pMin = Math.min(a.price, b.price), pMax = Math.max(a.price, b.price);
  return p.time >= tMin && p.time <= tMax && p.price >= pMin && p.price <= pMax;
}

/**
 * Hit-test a drawing. Returns the matched drawing id, or null.
 * `tolerance` is in price units; the time weight converts seconds into the same
 * scale so the tolerance is isotropic on screen.
 */
export function hitTest(
  drawings: readonly Drawing[],
  p: Point,
  tolerance = 0.5,
  timeWeight = 1e-6,
): string | null {
  // Iterate in reverse: the most recently added drawing sits on top.
  for (let i = drawings.length - 1; i >= 0; i--) {
    const d = drawings[i]!;
    if (d.locked) continue;
    if (hitOne(d, p, tolerance, timeWeight)) return d.id;
  }
  return null;
}

function hitOne(d: Drawing, p: Point, tol: number, tw: number): boolean {
  switch (d.kind) {
    case "hline": {
      const a = d.points[0];
      return a != null && Math.abs(p.price - a.price) <= tol;
    }
    case "vline": {
      const a = d.points[0];
      return a != null && Math.abs(p.time - a.time) * tw <= tol;
    }
    case "text": {
      const a = d.points[0];
      return a != null &&
        Math.abs(p.time - a.time) * tw <= tol * 4 &&
        Math.abs(p.price - a.price) <= tol * 4;
    }
    case "rectangle":
    case "long-position":
    case "short-position": {
      const [a, b] = d.points;
      if (!a || !b) return false;
      // hit the border, not the interior, so clicks inside can still pan
      const inside = pointInRect(p, a, b);
      const onEdge =
        Math.abs(p.price - a.price) <= tol || Math.abs(p.price - b.price) <= tol ||
        Math.abs(p.time - a.time) * tw <= tol || Math.abs(p.time - b.time) * tw <= tol;
      return inside && onEdge;
    }
    case "ray": {
      const [a, b] = d.points;
      return !!a && !!b && distanceToRay(p, a, b, tw) <= tol;
    }
    case "channel": {
      const [a, b, c] = d.points;
      if (!a || !b) return false;
      if (distanceToSegment(p, a, b, tw) <= tol) return true;
      if (c) return distanceToSegment(p, b, c, tw) <= tol;
      return false;
    }
    default: {
      const [a, b] = d.points;
      return !!a && !!b && distanceToSegment(p, a, b, tw) <= tol;
    }
  }
}

/** Fibonacci retracement price for a level, from an impulse a -> b. */
export function fibPrice(a: Point, b: Point, level: number): number {
  return b.price - (b.price - a.price) * level;
}

/** Fibonacci extension price (beyond b) for a level > 1. */
export function fibExtensionPrice(a: Point, b: Point, level: number): number {
  return a.price + (b.price - a.price) * level;
}

/** The parallel line of a channel: offset of the third point applied to a-b. */
export function channelOffset(d: Drawing): number | null {
  const [a, b, c] = d.points;
  if (!a || !b || !c) return null;
  const slope = (b.price - a.price) / Math.max(1, b.time - a.time);
  const expectedAtC = a.price + slope * (c.time - a.time);
  return c.price - expectedAtC;
}

/** Long/short position tool: derived risk/reward geometry. */
export interface PositionGeometry {
  entry: number;
  stop: number;
  target: number;
  risk: number;
  reward: number;
  rMultiple: number;
  side: "long" | "short";
}

export function positionGeometry(d: Drawing): PositionGeometry | null {
  const [entry, stop, target] = d.points;
  if (!entry || !stop) return null;
  const side = d.kind === "long-position" ? "long" : "short";
  const risk = Math.abs(entry.price - stop.price);
  const reward = target ? Math.abs(target.price - entry.price) : 0;
  return {
    entry: entry.price,
    stop: stop.price,
    target: target?.price ?? 0,
    risk,
    reward,
    rMultiple: risk > 0 ? reward / risk : 0,
    side,
  };
}

/**
 * Undo/redo stack over a drawing collection.
 *
 * Kept as an explicit snapshot stack rather than per-operation inverses: the
 * collections are small (tens of drawings), and snapshots cannot drift out of
 * sync the way hand-written inverses do.
 */
export class DrawingHistory {
  private past: Drawing[][] = [];
  private future: Drawing[][] = [];
  private current: Drawing[] = [];

  constructor(private limit = 100) {}

  get(): readonly Drawing[] {
    return this.current;
  }

  /** Apply a mutation and record the previous state. */
  commit(next: Drawing[]): void {
    this.past.push(this.current);
    if (this.past.length > this.limit) this.past.shift();
    this.current = next;
    this.future = [];
  }

  undo(): readonly Drawing[] {
    const prev = this.past.pop();
    if (!prev) return this.current;
    this.future.push(this.current);
    this.current = prev;
    return this.current;
  }

  redo(): readonly Drawing[] {
    const next = this.future.pop();
    if (!next) return this.current;
    this.past.push(this.current);
    this.current = next;
    return this.current;
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }
  canRedo(): boolean {
    return this.future.length > 0;
  }
  reset(drawings: Drawing[] = []): void {
    this.current = drawings;
    this.past = [];
    this.future = [];
  }
}
