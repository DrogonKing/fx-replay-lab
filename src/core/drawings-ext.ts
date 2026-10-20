/**
 * Additional drawing tools matching TradingView's shape set, plus the math they
 * need. Kept separate from drawings.ts so the core hit-test/distance helpers stay
 * focused; this module builds on them.
 *
 * Everything is in DATA space (time, price) so drawings survive zoom, timeframe
 * changes and window resize. Nothing here touches the DOM.
 */
import type { DrawingKind, Point } from "./drawings.js";

/**
 * Alias of DrawingKind, not a second list.
 * drawings.ts owns the enumeration; this module only adds geometry.
 */
export type ShapeKind = DrawingKind;

/** Points required by each shape family. */
export function pointsNeeded(kind: ShapeKind): number {
  switch (kind) {
    case "hline": case "vline": case "text": case "note": case "callout":
    case "price-label": case "arrow-marker": case "flag": case "comment":
    case "signpost": case "balloon": case "zoom-in": case "horizontal-ray":
      return 1;
    case "triangle": case "pitchfork": case "fib-channel": case "gann-fan":
    case "gann-box": case "fib-wedge":
      return 3;
    case "xabcd": case "abcd": case "triangle-pattern": case "head-shoulders":
      return 5;
    case "three-drives": case "elliott-impulse": case "cypher": case "bat":
    case "crab": case "butterfly": case "shark": case "five-points-pattern":
      return 6;
    case "elliott-correction":
      return 3;
    default:
      return 2;
  }
}

/** True when the shape is drawn between two free points (drag to create). */
export function isDragShape(kind: ShapeKind): boolean {
  return [
    "rectangle", "rotated-rectangle", "ellipse", "circle", "trendline", "ray",
    "extended-line", "measure", "fib-retracement", "fib-extension",
    "long-position", "short-position", "projection", "date-range",
    "price-range", "date-price-range", "arrow", "arc", "curve",
  ].includes(kind);
}

// ---------------------------------------------------------------- geometry

/** Point on a line defined by a and b, extended to a given time. */
export function lineAt(a: Point, b: Point, time: number): number {
  if (b.time === a.time) return a.price;
  const slope = (b.price - a.price) / (b.time - a.time);
  return a.price + slope * (time - a.time);
}

/** Slope in price per second. */
export function slope(a: Point, b: Point): number {
  if (b.time === a.time) return 0;
  return (b.price - a.price) / (b.time - a.time);
}

/** Angle in degrees given a time->x and price->y scale (both in pixels). */
export function angleDegrees(a: Point, b: Point, pxPerSec: number, pxPerPrice: number): number {
  const dx = (b.time - a.time) * pxPerSec;
  const dy = (b.price - a.price) * pxPerPrice;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/** Solve the second point that gives a target angle from the first. */
export function pointAtAngle(
  a: Point, b: Point, targetDeg: number, pxPerSec: number, pxPerPrice: number,
): Point {
  const dx = (b.time - a.time) * pxPerSec;
  const len = Math.hypot(dx, (b.price - a.price) * pxPerPrice);
  const rad = (targetDeg * Math.PI) / 180;
  const newDx = len * Math.cos(rad);
  const newDy = len * Math.sin(rad);
  return {
    time: a.time + newDx / pxPerSec,
    price: a.price + newDy / pxPerPrice,
  };
}

/**
 * Parallel channel lines from three points: the base line a->b, and a parallel
 * through c. Returns the two points defining the parallel line.
 */
export function channelParallel(a: Point, b: Point, c: Point): [Point, Point] {
  const off = c.price - lineAt(a, b, c.time);
  return [
    { time: a.time, price: a.price + off },
    { time: b.time, price: b.price + off },
  ];
}

/**
 * Andrews pitchfork: median line from the pivot through the midpoint of the two
 * outer points, plus two parallels offset to each outer point.
 *
 * Standard construction (what TradingView draws):
 *   pivot -> midpoint(B, C) is the median
 *   parallels of the median through B and through C
 */
export interface PitchforkGeometry {
  median: [Point, Point];
  upper: [Point, Point];
  lower: [Point, Point];
}

export function pitchfork(
  pivotPt: Point,
  b: Point,
  c: Point,
  /**
   * Where the three lines stop. Must be strictly greater than max(b.time, c.time):
   * deriving it as max(...) collapsed the lower parallel to a zero-length segment
   * whenever c was the rightmost point, which is the normal case. The caller
   * passes the chart's right edge; the default extends one B->C span past the
   * outer point so the geometry is always visible.
   */
  endTime?: number,
): PitchforkGeometry {
  const mid: Point = {
    time: (b.time + c.time) / 2,
    price: (b.price + c.price) / 2,
  };
  const medSlope = slope(pivotPt, mid);

  const last = Math.max(b.time, c.time);
  const end = endTime !== undefined && endTime > last
    ? endTime
    : last + Math.abs(c.time - b.time);

  const project = (from: Point): Point => ({
    time: end,
    price: from.price + medSlope * (end - from.time),
  });

  return {
    median: [pivotPt, project(pivotPt)],
    upper: [b, project(b)],
    lower: [c, project(c)],
  };
}

/** Ellipse bounds normalised so min <= max (PIL/SVG friendly). */
export function ellipseBounds(a: Point, b: Point): {
  tMin: number; tMax: number; pMin: number; pMax: number;
  cx: number; cy: number; rx: number; ry: number;
} {
  const tMin = Math.min(a.time, b.time);
  const tMax = Math.max(a.time, b.time);
  const pMin = Math.min(a.price, b.price);
  const pMax = Math.max(a.price, b.price);
  return {
    tMin, tMax, pMin, pMax,
    cx: (tMin + tMax) / 2,
    cy: (pMin + pMax) / 2,
    rx: (tMax - tMin) / 2,
    ry: (pMax - pMin) / 2,
  };
}

/** Is a point inside an ellipse defined by two corners? */
export function pointInEllipse(p: Point, a: Point, b: Point): boolean {
  const e = ellipseBounds(a, b);
  if (e.rx === 0 || e.ry === 0) return false;
  const dx = (p.time - e.cx) / e.rx;
  const dy = (p.price - e.cy) / e.ry;
  return dx * dx + dy * dy <= 1;
}

/** Regular polygon vertices around a centre, for the triangle/polygon tools. */
export function polygonPoints(a: Point, b: Point, sides: number): Point[] {
  const e = ellipseBounds(a, b);
  const out: Point[] = [];
  for (let i = 0; i < sides; i++) {
    const ang = (2 * Math.PI * i) / sides - Math.PI / 2;
    out.push({
      time: e.cx + Math.cos(ang) * e.rx,
      price: e.cy + Math.sin(ang) * e.ry,
    });
  }
  return out;
}

// -------------------------------------------------------------------- fib

/**
 * Escalating Fibonacci levels. TradingView's retracement lists the first set;
 * the extension continues beyond 1.
 */
export const FIB_RETRACEMENT_LEVELS = [
  0, 0.236, 0.382, 0.5, 0.618, 0.786, 1,
];

export const FIB_EXTENSION_LEVELS = [
  0, 0.618, 1, 1.272, 1.618, 2, 2.618, 3.618, 4.236,
];

/** All retracement levels as {level, price} for an impulse a -> b. */
export function fibLevels(
  a: Point, b: Point, levels: readonly number[],
): Array<{ level: number; price: number }> {
  return levels.map((level) => ({
    level,
    price: b.price - (b.price - a.price) * level,
  }));
}

/** Fib time zones: vertical lines at fib intervals of the a->b time span. */
export function fibTimeZones(
  a: Point, b: Point, levels: readonly number[],
): Array<{ level: number; time: number }> {
  const span = b.time - a.time;
  return levels.map((level) => ({ level, time: a.time + span * level }));
}

/** Fib channel: parallel copies of the a->b direction anchored on c. */
export function fibChannel(
  a: Point, b: Point, c: Point, levels: readonly number[],
): Array<{ level: number; points: [Point, Point] }> {
  const base = b.price - lineAt(a, b, b.time);
  void base;
  const anchorPrice = lineAt(a, b, c.time);
  const span = c.price - anchorPrice;
  return levels.map((level) => {
    const off = span * level;
    return {
      level,
      points: [
        { time: a.time, price: a.price + off },
        { time: b.time, price: b.price + off },
      ] as [Point, Point],
    };
  });
}

/** Gann fan angles, in degrees from horizontal. */
export const GANN_ANGLES = [7.5, 15, 26.25, 45, 63.75, 75, 82.5];

/** Gann fan: rays from a through b at each fixed angle. */
export function gannFan(
  a: Point, b: Point, pxPerSec: number, pxPerPrice: number, endTime: number,
): Array<{ angle: number; end: Point }> {
  return GANN_ANGLES.map((angle) => {
    const rad = (angle * Math.PI) / 180;
    const dt = endTime - a.time;
    const dxPx = dt * pxPerSec;
    const dyPx = Math.tan(rad) * dxPx;
    return {
      angle,
      end: { time: endTime, price: a.price + dyPx / pxPerPrice },
    };
  });
}

// ---------------------------------------------------------------- patterns

/**
 * XABCD pattern ratios.
 *
 * A valid XABCD needs each leg inside a tolerance band (TradingView's defaults
 * are used here). Returning the ratios plus a validity verdict is more useful
 * than drawing lines and letting the user guess.
 */
export interface XabcdRatios {
  ab: number;   // AB / XA
  bc: number;   // BC / AB
  cd: number;   // CD / BC
  ad: number;   // AD / XA
  valid: boolean;
  problems: string[];
}

export function xabcdRatios(points: readonly Point[]): XabcdRatios | null {
  if (points.length < 5) return null;
  const [X, A, B, C, D] = points as [Point, Point, Point, Point, Point];

  const leg = (p: Point, q: Point): number => Math.abs(q.price - p.price);
  const xa = leg(X, A);
  const ab = leg(A, B);
  const bc = leg(B, C);
  const cd = leg(C, D);
  const ad = leg(A, D);

  const r = {
    ab: xa > 0 ? ab / xa : 0,
    bc: ab > 0 ? bc / ab : 0,
    cd: bc > 0 ? cd / bc : 0,
    ad: xa > 0 ? ad / xa : 0,
  };

  const problems: string[] = [];
  if (xr(r.ab, 0.382, 0.618)) problems.push(`AB/XA ${r.ab.toFixed(3)} outside 0.382-0.618`);
  if (xr(r.bc, 0.382, 0.886)) problems.push(`BC/AB ${r.bc.toFixed(3)} outside 0.382-0.886`);
  if (xr(r.cd, 1.13, 2.618)) problems.push(`CD/BC ${r.cd.toFixed(3)} outside 1.13-2.618`);
  if (xr(r.ad, 0.786, 0.886)) problems.push(`AD/XA ${r.ad.toFixed(3)} outside 0.786-0.886`);

  return { ...r, valid: problems.length === 0, problems };
}

function xr(v: number, lo: number, hi: number): boolean {
  return v < lo || v > hi;
}

/** Elliott impulse validity: 5 waves, wave 2 not past start, wave 3 not shortest. */
export function elliottImpulseCheck(points: readonly Point[]): string[] {
  if (points.length < 6) return ["needs 6 points (start + 5 waves)"];
  const problems: string[] = [];
  const p = points;

  const len = (i: number): number => Math.abs(p[i + 1]!.price - p[i]!.price);
  const w1 = len(0), w3 = len(2), w5 = len(4);

  // wave 3 is never the shortest of 1/3/5
  if (w3 < w1 && w3 < w5) problems.push("wave 3 is the shortest of 1/3/5");

  // wave 2 must not retrace past the start of wave 1
  const dir = Math.sign(p[1]!.price - p[0]!.price);
  if (dir > 0 && p[2]!.price < p[0]!.price) problems.push("wave 2 retraces past wave 1 start");
  if (dir < 0 && p[2]!.price > p[0]!.price) problems.push("wave 2 retraces past wave 1 start");

  // wave 4 must not enter wave 1 territory
  if (dir > 0 && p[4]!.price < p[1]!.price) problems.push("wave 4 overlaps wave 1");
  if (dir < 0 && p[4]!.price > p[1]!.price) problems.push("wave 4 overlaps wave 1");

  return problems;
}

// ------------------------------------------------------------ measurement

export interface MeasureResult {
  bars: number;
  seconds: number;
  priceDelta: number;
  /** absolute change as a percent of the starting price */
  percent: number;
  /** true when the result is a gain */
  up: boolean;
}

export function measure(a: Point, b: Point): MeasureResult {
  const priceDelta = b.price - a.price;
  return {
    bars: 0,   // caller fills from the series; time cannot know the bar size
    seconds: b.time - a.time,
    priceDelta,
    percent: a.price !== 0 ? (priceDelta / a.price) * 100 : 0,
    up: priceDelta >= 0,
  };
}

/** Risk/reward for the position tools, given an optional target. */
export interface PositionMetrics {
  entry: number;
  stop: number;
  target: number | null;
  risk: number;
  reward: number;
  rMultiple: number;
  side: "long" | "short";
  /** account money at a given lot size and contract size */
  riskMoney: (lots: number, contractSize: number) => number;
  rewardMoney: (lots: number, contractSize: number) => number;
}

export function positionMetrics(
  kind: "long-position" | "short-position",
  entry: Point, stop: Point, target?: Point,
): PositionMetrics {
  const side = kind === "long-position" ? "long" : "short";
  const risk = Math.abs(entry.price - stop.price);
  const reward = target ? Math.abs(target.price - entry.price) : 0;
  return {
    entry: entry.price,
    stop: stop.price,
    target: target?.price ?? null,
    risk,
    reward,
    rMultiple: risk > 0 ? reward / risk : 0,
    side,
    riskMoney: (lots, contractSize) => risk * lots * contractSize,
    rewardMoney: (lots, contractSize) => reward * lots * contractSize,
  };
}
