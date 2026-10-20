/**
 * Position management: SL/TP drag handles and automatic break-even.
 *
 * Pure functions over price levels. The drag math and the break-even trigger are the
 * two places where a sign error silently doubles your risk instead of erroring, so
 * both are asserted directly rather than only exercised through the UI.
 */
import type { Position, Side } from "./types.js";

export type HandleKind = "entry" | "sl" | "tp";

export interface PriceLine {
  kind: HandleKind;
  price: number;
  side: Side;
  positionId: number;
  /** draggable = user may move this handle */
  draggable: boolean;
  label: string;
}

/**
 * The three lines to draw for a position.
 *
 * Only SL and TP are draggable by default: the entry price is history and moving it
 * would rewrite a fill that already happened.
 */
export function positionLines(p: Position): PriceLine[] {
  const out: PriceLine[] = [
    {
      kind: "entry", price: p.entryPrice, side: p.side, positionId: p.id,
      draggable: false, label: `entry ${p.entryPrice.toFixed(2)}`,
    },
  ];
  if (p.sl !== null) {
    out.push({
      kind: "sl", price: p.sl, side: p.side, positionId: p.id,
      draggable: true, label: `SL ${p.sl.toFixed(2)}`,
    });
  }
  if (p.tp !== null) {
    out.push({
      kind: "tp", price: p.tp, side: p.side, positionId: p.id,
      draggable: true, label: `TP ${p.tp.toFixed(2)}`,
    });
  }
  return out;
}

/** Closest draggable handle within `tolerance`, or null. */
export function hitHandle(
  lines: readonly PriceLine[],
  price: number,
  tolerance: number,
): PriceLine | null {
  let best: PriceLine | null = null;
  let bestDist = tolerance;
  for (const l of lines) {
    if (!l.draggable) continue;
    const d = Math.abs(l.price - price);
    if (d <= bestDist) {
      bestDist = d;
      best = l;
    }
  }
  return best;
}

export interface MoveResult {
  /** the new level, or null when the move is rejected */
  price: number | null;
  /** why it was rejected, for the UI to show */
  reason?: string;
}

/**
 * Where a dragged stop/target may legally go.
 *
 * The rule that matters: a stop must stay on the losing side of the entry and a
 * target on the winning side. Allowing the drag to cross the entry turns a stop into
 * a guaranteed instant loss and a target into an instant win, which looks like the
 * app handing out free money. A minimum distance is also enforced so a stop cannot be
 * dropped exactly on the entry and become unpredictable.
 */
export function constrainLevel(
  p: Position,
  kind: Extract<HandleKind, "sl" | "tp">,
  proposed: number,
  minDistance: number,
): MoveResult {
  if (!Number.isFinite(proposed)) return { price: null, reason: "invalid price" };

  // Keep a small buffer: a level exactly at the entry is ambiguous (is it a stop or a
  // target?) and a market that ticked through it would close the trade instantly.
  const buffer = Math.max(minDistance, 0);
  const isBuy = p.side === "buy";

  if (kind === "sl") {
    if (isBuy && proposed > p.entryPrice - buffer) {
      return {
        price: null,
        reason: `a buy's stop must stay below the entry (${p.entryPrice.toFixed(2)})`,
      };
    }
    if (!isBuy && proposed < p.entryPrice + buffer) {
      return {
        price: null,
        reason: `a sell's stop must stay above the entry (${p.entryPrice.toFixed(2)})`,
      };
    }
    return { price: proposed };
  }

  // target
  if (isBuy && proposed < p.entryPrice + buffer) {
    return {
      price: null,
      reason: `a buy's target must stay above the entry (${p.entryPrice.toFixed(2)})`,
    };
  }
  if (!isBuy && proposed > p.entryPrice - buffer) {
    return {
      price: null,
      reason: `a sell's target must stay below the entry (${p.entryPrice.toFixed(2)})`,
    };
  }
  return { price: proposed };
}

/** Risk in price units, from the current stop. 0 when there is no stop. */
export function riskDistance(p: Position): number {
  return p.sl === null ? 0 : Math.abs(p.entryPrice - p.sl);
}

/** Reward in price units, from the current target. 0 when there is none. */
export function rewardDistance(p: Position): number {
  return p.tp === null ? 0 : Math.abs(p.tp - p.entryPrice);
}

/** Current reward:risk, or 0 when either leg is missing. */
export function currentR(p: Position): number {
  const risk = riskDistance(p);
  if (risk <= 0) return 0;
  return rewardDistance(p) / risk;
}

/** How far price has travelled in the trade's favour, in R multiples. */
export function profitInR(p: Position, currentPrice: number): number {
  const risk = riskDistance(p);
  if (risk <= 0) return 0;
  const favourable = p.side === "buy"
    ? currentPrice - p.entryPrice
    : p.entryPrice - currentPrice;
  return favourable / risk;
}

export interface BreakEvenDecision {
  /** set when the stop should move, to this price */
  newStop: number | null;
  reason?: string;
}

/**
 * Break-even: move the stop to the entry once profit reaches `triggerR`.
 *
 * Only ever TIGHTENS the stop. Moving a stop backwards would increase risk on a trade
 * that is already working, which no automation should do silently.
 *
 * `commission` is included because "at entry" is not break-even once you have paid to
 * get in: the true zero-profit price on a buy is entry + commission/(lots*contract).
 */
export function breakEven(
  p: Position,
  currentPrice: number,
  triggerR: number,
  commission = 0,
  lots = 1,
  contractSize = 1,
): BreakEvenDecision {
  if (p.sl === null) return { newStop: null, reason: "no stop to move" };
  if (triggerR <= 0) return { newStop: null, reason: "trigger must be positive" };

  const risk = riskDistance(p);
  // Check break-even BEFORE the zero-risk guard: a stop sitting exactly on the entry
  // has zero risk, and reporting "zero risk distance" there hides the real state from
  // the user. Such a position cannot be stopped out at all, so say so.
  if (risk <= 0) {
    return {
      newStop: null,
      reason: "stop is at the entry — the position has no risk to manage "
        + "(move it away from the entry first)",
    };
  }

  const inR = profitInR(p, currentPrice);
  if (inR < triggerR) {
    return { newStop: null, reason: `at ${inR.toFixed(2)}R, needs ${triggerR}R` };
  }

  // zero-P/L price, not the raw entry: commission was already charged on entry, so
  // "break even" means recovering it too
  const perPriceUnit = Math.abs(lots * contractSize);
  const commissionPrice = perPriceUnit > 0 ? Math.abs(commission) / perPriceUnit : 0;
  const zeroPnl = p.side === "buy"
    ? p.entryPrice + commissionPrice
    : p.entryPrice - commissionPrice;

  const isBuy = p.side === "buy";
  // already at or beyond break-even?
  const already = isBuy ? p.sl >= zeroPnl : p.sl <= zeroPnl;
  if (already) return { newStop: null, reason: "stop is already at break-even" };

  return { newStop: zeroPnl };
}

/**
 * Apply break-even to a position, returning the new stop price or null.
 *
 * Separated from `breakEven` so the decision can be inspected (and logged) before it
 * mutates anything.
 */
export function applyBreakEven(
  p: Position,
  currentPrice: number,
  triggerR: number,
  commission?: number,
  lots?: number,
  contractSize?: number,
): number | null {
  const d = breakEven(p, currentPrice, triggerR, commission, lots, contractSize);
  return d.newStop;
}

/** Human summary for the positions table. */
export function describePosition(p: Position, currentPrice: number): string {
  const r = profitInR(p, currentPrice);
  const sign = r >= 0 ? "+" : "";
  return `${p.side} ${p.lots} @ ${p.entryPrice.toFixed(2)} · ${sign}${r.toFixed(2)}R`;
}
