/**
 * Serialisation for drawings and journal entries.
 *
 * Kept in core and pure so the round-trip is unit-tested without Electron or
 * SQLite. Persistence bugs are silent by nature — a drawing that loads back with
 * one point missing still draws something, just the wrong thing — so every shape
 * is verified by a property test that serialises and re-reads it.
 */
import type { Drawing, DrawingKind, Point } from "./drawings.js";

export interface JournalEntry {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  lots: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  /** initial risk in money, used for the R multiple */
  risk: number;
  tags: string[];
  notes: string;
}

export const SCHEMA_VERSION = 1;

export interface StoredDrawings {
  version: number;
  drawings: Drawing[];
}

export interface StoredJournal {
  version: number;
  entries: JournalEntry[];
}

/**
 * JSON that survives a database round trip without surprises.
 *
 * `kind` is deliberately `string` here: this is the UNTRUSTED side. Narrowing it to
 * DrawingKind would be a lie, since the value comes from disk and may be anything.
 */
export interface WireDrawing {
  id: string;
  kind: string;
  points: Array<{ t: number; p: number }>;
  color: string;
  width: number;
  text?: string;
  levels?: number[];
  locked?: boolean;
  dashed?: boolean;
}

export interface WireJournal {
  id: string;
  symbol: string;
  side: string;
  lots: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  risk: number;
  tags: string[];
  notes: string;
}

const KNOWN_KINDS: ReadonlySet<string> = new Set<DrawingKind>([
  "trendline", "hline", "vline", "ray", "extended-line", "cross-line",
  "trend-angle", "horizontal-ray",
  "channel", "pitchfork", "regression-trend",
  "rectangle", "rotated-rectangle", "ellipse", "circle", "triangle",
  "arc", "curve", "path", "polygon", "double-curve",
  "fib-retracement", "fib-extension", "fib-channel", "fib-time-zone",
  "fib-speed-fan", "fib-arcs", "fib-wedge", "gann-fan", "gann-box",
  "text", "note", "callout", "price-label", "arrow", "arrow-marker",
  "flag", "comment", "signpost", "balloon",
  "xabcd", "abcd", "triangle-pattern", "three-drives", "head-shoulders",
  "elliott-impulse", "elliott-correction", "cypher", "bat", "crab",
  "butterfly", "shark", "five-points-pattern",
  "long-position", "short-position", "projection", "date-range",
  "price-range", "date-price-range", "ghost-feed",
  "measure", "zoom-in",
]);

/**
 * Serialise drawings.
 *
 * Points are written as short keys `{t,p}` because a workspace with a few hundred
 * drawings otherwise carries a lot of repeated `time`/`price` text for no benefit.
 */
export interface StoredDrawingsWire {
  version: number;
  drawings: WireDrawing[];
}

export function serialiseDrawings(drawings: readonly Drawing[]): StoredDrawingsWire {
  return {
    version: SCHEMA_VERSION,
    drawings: drawings.map((d) => {
      const wire: WireDrawing = {
        id: d.id,
        kind: d.kind,
        points: d.points.map((p) => ({ t: p.time, p: p.price })),
        color: d.color,
        width: d.width,
      };
      if (d.text !== undefined) wire.text = d.text;
      if (d.levels !== undefined) wire.levels = [...d.levels];
      if (d.locked !== undefined) wire.locked = d.locked;
      if (d.dashed !== undefined) wire.dashed = d.dashed;
      return wire;
    }),
  };
}

export interface ParseResult<T> {
  value: T;
  /** entries dropped because they were malformed, with a reason */
  rejected: string[];
}

/**
 * Read drawings back, dropping anything malformed.
 *
 * Dropping rather than throwing matters: a single corrupt row (from a crash mid
 * write, or a hand-edited file) must not make the whole workspace unloadable.
 * Every drop is reported so the UI can say how many were lost.
 */
export function parseDrawings(input: unknown): ParseResult<Drawing[]> {
  const rejected: string[] = [];
  const out: Drawing[] = [];

  if (!isObject(input) || !Array.isArray(input.drawings)) {
    return { value: [], rejected: ["payload is not a drawings object"] };
  }

  const raw = input.drawings as unknown[];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isObject(item)) {
      rejected.push(`#${i}: not an object`);
      continue;
    }
    const w = item as unknown as WireDrawing;

    if (typeof w.id !== "string" || w.id.length === 0) {
      rejected.push(`#${i}: missing id`);
      continue;
    }
    if (typeof w.kind !== "string" || !KNOWN_KINDS.has(w.kind)) {
      rejected.push(`#${i} (${w.id}): unknown kind "${String(w.kind)}"`);
      continue;
    }
    if (!Array.isArray(w.points) || w.points.length === 0) {
      rejected.push(`#${i} (${w.id}): no points`);
      continue;
    }

    const points: Point[] = [];
    let bad = false;
    for (const p of w.points) {
      if (!isObject(p) || !Number.isFinite(p.t) || !Number.isFinite(p.p)) {
        bad = true;
        break;
      }
      points.push({ time: p.t, price: p.p });
    }
    if (bad) {
      rejected.push(`#${i} (${w.id}): non-finite point`);
      continue;
    }

    const d: Drawing = {
      id: w.id,
      kind: w.kind as DrawingKind,
      points,
      color: typeof w.color === "string" ? w.color : "#f0b90b",
      width: Number.isFinite(w.width) && w.width > 0 ? w.width : 2,
    };
    if (typeof w.text === "string") d.text = w.text;
    if (Array.isArray(w.levels)) {
      d.levels = w.levels.filter((l) => Number.isFinite(l));
    }
    if (typeof w.locked === "boolean") d.locked = w.locked;
    if (typeof w.dashed === "boolean") d.dashed = w.dashed;

    out.push(d);
  }

  return { value: out, rejected };
}

export function serialiseJournal(entries: readonly JournalEntry[]): StoredJournal {
  return {
    version: SCHEMA_VERSION,
    entries: entries.map((e) => ({
      id: e.id,
      symbol: e.symbol,
      side: e.side,
      lots: e.lots,
      entryTime: e.entryTime,
      exitTime: e.exitTime,
      entryPrice: e.entryPrice,
      exitPrice: e.exitPrice,
      pnl: e.pnl,
      risk: e.risk,
      tags: [...e.tags],
      notes: e.notes,
    })),
  };
}

/**
 * Read journal entries back.
 *
 * `side` is normalised to buy/sell: a stored value of anything else is a bug, and
 * guessing "buy" would silently turn a losing short into a winning long in the
 * analytics, so it is rejected instead.
 */
export function parseJournal(input: unknown): ParseResult<JournalEntry[]> {
  const rejected: string[] = [];
  const out: JournalEntry[] = [];

  if (!isObject(input) || !Array.isArray(input.entries)) {
    return { value: [], rejected: ["payload is not a journal object"] };
  }

  const raw = input.entries as unknown[];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isObject(item)) {
      rejected.push(`#${i}: not an object`);
      continue;
    }
    const w = item as unknown as WireJournal;

    if (typeof w.id !== "string" || w.id.length === 0) {
      rejected.push(`#${i}: missing id`);
      continue;
    }
    if (w.side !== "buy" && w.side !== "sell") {
      rejected.push(`#${i} (${w.id}): invalid side "${String(w.side)}"`);
      continue;
    }
    const nums: Array<[string, unknown]> = [
      ["lots", w.lots], ["entryTime", w.entryTime], ["exitTime", w.exitTime],
      ["entryPrice", w.entryPrice], ["exitPrice", w.exitPrice],
      ["pnl", w.pnl], ["risk", w.risk],
    ];
    const badNum = nums.find(([, v]) => !Number.isFinite(v));
    if (badNum) {
      rejected.push(`#${i} (${w.id}): non-finite ${badNum[0]}`);
      continue;
    }

    out.push({
      id: w.id,
      symbol: typeof w.symbol === "string" ? w.symbol : "",
      side: w.side,
      lots: w.lots,
      entryTime: w.entryTime,
      exitTime: w.exitTime,
      entryPrice: w.entryPrice,
      exitPrice: w.exitPrice,
      pnl: w.pnl,
      risk: w.risk,
      tags: Array.isArray(w.tags) ? w.tags.filter((t) => typeof t === "string") : [],
      notes: typeof w.notes === "string" ? w.notes : "",
    });
  }

  return { value: out, rejected };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Stable key for a workspace.
 *
 * Drawings belong to a symbol AND a timeframe: a trend line drawn on M5 has no
 * meaning on D1, so keying only by symbol would make it appear at a random place
 * on every other timeframe.
 */
export function workspaceKey(symbol: string, timeframe: string): string {
  return `${symbol}::${timeframe}`;
}
