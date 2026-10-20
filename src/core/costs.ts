/**
 * Realistic trading costs: overnight swap, slippage, and the margin-call threshold.
 *
 * Pure. These were the three places where the simulator was kinder than a broker:
 *
 *   - a position held for a week cost nothing overnight;
 *   - a stop fill was exact, when in reality a stop is a MARKET order once touched;
 *   - the account simply went to zero, with no margin call before it.
 *
 * Each function takes the trade's own data and returns the money, so the engine never does
 * cost arithmetic inline and there is one place where the sign can be wrong.
 */
import type { Side, SymbolSpec } from "./types.js";

/** Overnight financing, in price units per lot per night. */
export interface SwapSpec {
  /** charged to a long position; usually negative for a positive-carry pair */
  longPerLotPerNight: number;
  /** charged to a short position */
  shortPerLotPerNight: number;
  /**
   * Hour (UTC) at which the night rolls over. 21:00 UTC is the standard FX rollover: it is
   * 17:00 New York, when the Fedwire day closes.
   */
  rolloverHourUtc: number;
  /**
   * Weekday multiplier.
   *
   * Wednesday is 3x in FX: the trade that would settle Saturday settles Monday instead, so
   * two extra days of financing are taken on Wednesday. Skipping this makes a week of
   * holding cost 5 nights instead of the 7 a broker charges.
   */
  wednesdayMultiplier: number;
}

export const DEFAULT_SWAP: SwapSpec = {
  longPerLotPerNight: 0,
  shortPerLotPerNight: 0,
  rolloverHourUtc: 21,
  wednesdayMultiplier: 3,
};

/** A symbol's swap rates, per lot per night, in account currency. */
export interface SwapRates {
  long: number;
  short: number;
}

/**
 * How many nightly rollovers occurred between two instants.
 *
 * Counts each occurrence of `rolloverHourUtc` strictly after `fromTime` and at or before
 * `toTime`. Integer arithmetic on the UTC day, so DST in the viewer's timezone cannot change
 * the number of nights charged.
 */
export function rolloversBetween(
  fromTime: number,
  toTime: number,
  spec: SwapSpec = DEFAULT_SWAP,
): { count: number; wednesdays: number } {
  if (!(toTime > fromTime)) return { count: 0, wednesdays: 0 };

  const hour = Math.max(0, Math.min(23, Math.floor(spec.rolloverHourUtc)));
  const dayMs = 86_400;
  const hourSec = hour * 3600;

  // first rollover strictly after fromTime
  const fromDay = Math.floor((fromTime - hourSec) / dayMs);
  const toDay = Math.floor((toTime - hourSec) / dayMs);

  let count = 0;
  let wednesdays = 0;
  for (let d = fromDay; d <= toDay; d++) {
    const rolloverAt = d * dayMs + hourSec;
    if (rolloverAt > fromTime && rolloverAt <= toTime) {
      count++;
      // 1970-01-01 was a Thursday; day 0 => Thursday, so day%7===3 is Sunday.
      // Wednesday is day%7===2.
      const dow = ((d % 7) + 7 + 4) % 7;   // 0=Sunday
      if (dow === 3) wednesdays++;
    }
  }
  return { count, wednesdays };
}

/**
 * Swap for holding `lots` of `side` from one instant to another.
 *
 * Negative = charged to the trader (the normal case), positive = credited.
 */
export function swapFor(
  side: Side,
  lots: number,
  fromTime: number,
  toTime: number,
  rates: SwapRates,
  spec: SwapSpec = DEFAULT_SWAP,
): number {
  if (!(lots > 0) || !(toTime > fromTime)) return 0;
  const { count, wednesdays } = rolloversBetween(fromTime, toTime, spec);
  if (count === 0) return 0;

  const perNight = side === "buy" ? rates.long : rates.short;
  if (perNight === 0) return 0;

  // Wednesday carries the weekend: replace one night with the multiplier.
  const extra = wednesdays * (Math.max(1, spec.wednesdayMultiplier) - 1);
  const nights = count + extra;
  return perNight * lots * nights;
}

export interface SlippageSpec {
  /** points of adverse slippage on a market order */
  marketPoints: number;
  /** extra points when a stop is triggered — liquidity is worse exactly then */
  stopPoints: number;
  /** points on a take-profit: usually 0 or negative, since a limit fills at or better */
  limitPoints: number;
  /** deterministic seed offset, so a replay is reproducible but not identical every fill */
  enabled: boolean;
}

export const DEFAULT_SLIPPAGE: SlippageSpec = {
  marketPoints: 0, stopPoints: 0, limitPoints: 0, enabled: false,
};

/** One point in price units. */
function onePoint(sym: SymbolSpec): number {
  return Math.pow(10, -sym.digits);
}

/**
 * Deterministic pseudo-random in [0,1), seeded by a value.
 *
 * A real broker's slippage is random, but a REPLAY must be reproducible: the same bar and the
 * same trade must produce the same fill every time, or a backtest cannot be repeated. This is
 * a hash, not Math.random.
 */
function hash01(seed: number): number {
  let x = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/**
 * Adverse price move for a fill, in price units, always against the trader.
 *
 * `seed` makes it reproducible: pass the bar time and the position id.
 */
export function slippageFor(
  kind: "market" | "stop" | "limit",
  sym: SymbolSpec,
  seed: number,
  spec: SlippageSpec = DEFAULT_SLIPPAGE,
): number {
  if (!spec.enabled) return 0;
  const base =
    kind === "stop" ? spec.stopPoints
    : kind === "limit" ? spec.limitPoints
    : spec.marketPoints;
  if (base === 0) return 0;

  // up to 100% of the configured figure, never more: a documented worst case is honest,
  // an unbounded random one is not reproducible or explainable.
  const factor = hash01(seed);
  return base * factor * onePoint(sym);
}

export interface MarginCallSpec {
  /** equity/margin ratio below which new positions are refused, e.g. 0.5 = 50% */
  callLevel: number;
  /** ratio below which everything is force-closed, e.g. 0.2 = 20% */
  stopOutLevel: number;
}

export const DEFAULT_MARGIN_CALL: MarginCallSpec = { callLevel: 0.5, stopOutLevel: 0.2 };

export type MarginState = "ok" | "call" | "stop-out";

/**
 * Margin state from equity and used margin.
 *
 * `call` means the account is warned and new risk should be refused; `stop-out` means the
 * broker closes everything. Previously only the second existed, at equity <= 0, which is
 * bankruptcy rather than a margin call.
 */
export function marginState(
  equity: number,
  usedMargin: number,
  spec: MarginCallSpec = DEFAULT_MARGIN_CALL,
): MarginState {
  if (usedMargin <= 0) return "ok";
  const ratio = equity / usedMargin;
  if (ratio <= spec.stopOutLevel) return "stop-out";
  if (ratio <= spec.callLevel) return "call";
  return "ok";
}

/** Margin level as a percentage, for display. 0 when nothing is used. */
export function marginLevelPercent(equity: number, usedMargin: number): number {
  if (usedMargin <= 0) return 0;
  return (equity / usedMargin) * 100;
}

/** One-line description for the panel. */
export function describeMargin(
  equity: number,
  usedMargin: number,
  spec: MarginCallSpec = DEFAULT_MARGIN_CALL,
): string {
  if (usedMargin <= 0) return "no margin in use";
  const pct = marginLevelPercent(equity, usedMargin);
  const st = marginState(equity, usedMargin, spec);
  if (st === "stop-out") return `margin level ${pct.toFixed(0)}% — stop out`;
  if (st === "call") return `margin level ${pct.toFixed(0)}% — margin call`;
  return `margin level ${pct.toFixed(0)}%`;
}
