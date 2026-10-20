/**
 * Whole-book risk: the total the account has at stake, across every open position and every
 * pending order that could still fill.
 *
 * Pure. Exists because per-trade risk is a misleading number on its own: three positions at
 * 1% each are each "safe" and together put 3% at risk. This module answers the question the
 * per-trade panel cannot — "what happens if everything goes wrong at once?"
 */
import type { Side, SymbolSpec } from "./types.js";
import type { PendingOrder } from "./orders.js";

export interface PositionRisk {
  id: number;
  symbol: string;
  side: Side;
  lots: number;
  /** distance from entry to stop, in price units; 0 when there is no stop */
  stopDistance: number;
  /** money at risk: stopDistance * contractSize * lots */
  money: number;
  /** percent of balance */
  percent: number;
  /** true when this position has no stop, so its risk is unbounded and unknown */
  unprotected: boolean;
}

export interface BookRisk {
  /** balance the percentages are measured against */
  balance: number;
  positions: PositionRisk[];
  /** money at risk across positions that HAVE a stop */
  openRisk: number;
  /** percent of balance */
  openPercent: number;
  /** positions with no stop: their risk is not counted, it is unknown */
  unprotectedCount: number;
  /** money that would be risked if every pending order filled at its stated stop */
  pendingRisk: number;
  pendingPercent: number;
  /** open + pending, i.e. the worst case if everything triggers and every stop is hit */
  totalRisk: number;
  totalPercent: number;
  /**
   * Net directional exposure in lots, buys positive and sells negative.
   *
   * Not risk, but the other half of "what happens at once": four 0.1-lot buys and three
   * 0.1-lot sells are 0.1 net, not 0.7.
   */
  netLots: number;
  grossLots: number;
  /** true when buys and sells are both open: a hedge, whose combined risk is not the sum */
  hedged: boolean;
}

export interface RiskLimit {
  /** percent of balance allowed across the whole book; 0 disables the guard */
  maxPercent: number;
}

/**
 * Off by default.
 *
 * A guard that refuses trades out of the box makes the app a gate rather than a tool: a user
 * who never asked for a book limit would find their tenth trade rejected. The risk READOUT is
 * always visible; the refusal only exists once a number is entered.
 */
export const DEFAULT_LIMIT: RiskLimit = { maxPercent: 0 };

/** Money at risk for one position, from its own stop. */
export function positionRisk(
  p: { id: number; symbol: string; side: Side; lots: number; entryPrice: number; sl: number | null },
  spec: SymbolSpec,
  balance: number,
): PositionRisk {
  // A stop of 0 or null is not "no risk", it is UNKNOWN risk: the position can lose
  // everything. Counting it as zero would make the book look safer the less protected it is.
  const stopDistance = p.sl === null ? 0 : Math.abs(p.entryPrice - p.sl);
  const unprotected = stopDistance <= 0;
  const money = unprotected ? 0 : stopDistance * spec.contractSize * p.lots;
  return {
    id: p.id,
    symbol: p.symbol,
    side: p.side,
    lots: p.lots,
    stopDistance,
    money,
    percent: balance > 0 ? (money / balance) * 100 : 0,
    unprotected,
  };
}

/**
 * Money at risk if a pending order fills.
 *
 * Uses the order's own `slDistance`, measured from its trigger price. This is an ESTIMATE of
 * the worst case, not a promise: a stop order can fill with slippage beyond its trigger, so
 * the real risk may be larger. It is labelled as such in the UI rather than presented as
 * exact.
 */
export function pendingRiskOf(o: PendingOrder, spec: SymbolSpec, balance: number): number {
  if (o.status !== "pending") return 0;
  if (!(o.slDistance > 0)) return 0;
  return o.slDistance * spec.contractSize * o.lots;
}

/** Total risk across positions and pending orders. */
export function bookRisk(
  balance: number,
  positions: ReadonlyArray<{
    id: number; symbol: string; side: Side; lots: number;
    entryPrice: number; sl: number | null;
  }>,
  pending: readonly PendingOrder[],
  spec: SymbolSpec,
): BookRisk {
  const perPosition = positions.map((p) => positionRisk(p, spec, balance));
  const openRisk = perPosition.reduce((sum, p) => sum + p.money, 0);

  const pendingMoney = pending.reduce(
    (sum, o) => sum + pendingRiskOf(o, spec, balance),
    0,
  );

  const buys = positions.filter((p) => p.side === "buy").reduce((s, p) => s + p.lots, 0);
  const sells = positions.filter((p) => p.side === "sell").reduce((s, p) => s + p.lots, 0);

  const pct = (money: number): number => (balance > 0 ? (money / balance) * 100 : 0);

  return {
    balance,
    positions: perPosition,
    openRisk,
    openPercent: pct(openRisk),
    unprotectedCount: perPosition.filter((p) => p.unprotected).length,
    pendingRisk: pendingMoney,
    pendingPercent: pct(pendingMoney),
    totalRisk: openRisk + pendingMoney,
    totalPercent: pct(openRisk + pendingMoney),
    netLots: buys - sells,
    grossLots: buys + sells,
    hedged: buys > 0 && sells > 0,
  };
}

export interface LimitCheck {
  /** true when the book is over the limit */
  breach: boolean;
  /** percent over the limit; 0 when inside */
  overBy: number;
  /** what the trade would take the total to, if a candidate size is supplied */
  projectedPercent?: number;
  /** true when accepting this trade would breach the limit */
  wouldBreach: boolean;
  reason?: string;
}

/**
 * Compare the book (optionally plus a candidate trade) against a limit.
 *
 * The candidate is checked BEFORE the order is placed: a limit that only complains after the
 * fact is a report, not a guard.
 */
export function checkLimit(
  book: BookRisk,
  limit: RiskLimit,
  candidate?: { percent: number },
): LimitCheck {
  if (!(limit.maxPercent > 0)) {
    return { breach: false, overBy: 0, wouldBreach: false };
  }

  const current = book.totalPercent;
  const projected = current + (candidate?.percent ?? 0);
  const breach = current > limit.maxPercent + 1e-9;
  const wouldBreach = projected > limit.maxPercent + 1e-9;

  // A position with no stop has UNKNOWN risk, not zero. That warning must be returned even
  // when no number is breached: an entirely unprotected book would otherwise report "fine",
  // which is exactly the case where the number is most misleading.
  const parts: string[] = [];
  if (wouldBreach) {
    parts.push(
      `this trade would put ${projected.toFixed(2)}% of the balance at risk,` +
      ` over the ${limit.maxPercent}% book limit`,
    );
  }
  if (book.unprotectedCount > 0) {
    parts.push(
      `${book.unprotectedCount} position(s) have no stop, so their risk is not in this number`,
    );
  }

  return {
    breach,
    overBy: wouldBreach ? projected - limit.maxPercent : 0,
    projectedPercent: projected,
    wouldBreach,
    reason: parts.length > 0 ? parts.join("; ") : undefined,
  };
}

/**
 * How much room is left before the limit, in percent of balance.
 *
 * Negative when already over — a clamp to zero would hide an existing breach.
 */
export function headroom(book: BookRisk, limit: RiskLimit): number {
  if (!(limit.maxPercent > 0)) return Infinity;
  return limit.maxPercent - book.totalPercent;
}

/** One-line summary for the panel. */
export function describeBook(book: BookRisk, limit: RiskLimit): string {
  const bits = [`${book.totalPercent.toFixed(2)}% at risk`];
  if (book.openRisk > 0) bits.push(`open ${book.openPercent.toFixed(2)}%`);
  if (book.pendingRisk > 0) bits.push(`pending ${book.pendingPercent.toFixed(2)}%`);
  if (book.unprotectedCount > 0) bits.push(`${book.unprotectedCount} without a stop`);
  if (limit.maxPercent > 0) bits.push(`limit ${limit.maxPercent}%`);
  return bits.join(" · ");
}
