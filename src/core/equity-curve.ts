/**
 * Equity curve: the account balance over time, for both the replay account and a backtest.
 *
 * Pure. The backtester already produced `equityCurve`, and the replay account has a balance
 * per bar, but nothing turned either into the series a chart can draw. This is that one
 * conversion, kept in core so both callers produce the same shape.
 */
import type { EquityPoint } from "./backtest.js";

export interface CurvePoint {
  /** UTC epoch seconds */
  time: number;
  equity: number;
  balance: number;
}

export interface CurveSummary {
  start: number;
  end: number;
  /** highest equity reached */
  peak: number;
  /** lowest equity after the peak that followed it */
  worstDrawdown: number;
  worstDrawdownPercent: number;
  /** current drawdown from the running peak */
  currentDrawdown: number;
  currentDrawdownPercent: number;
  /** true when the curve finished below where it started */
  losing: boolean;
  points: number;
}

const EMPTY: CurveSummary = {
  start: 0, end: 0, peak: 0, worstDrawdown: 0, worstDrawdownPercent: 0,
  currentDrawdown: 0, currentDrawdownPercent: 0, losing: false, points: 0,
};

/**
 * Running-peak drawdown.
 *
 * Percentage is measured against the PEAK, not the start: a $1,000 drop from a $10,000 peak
 * is 10%, whether or not the account started at $5,000. Measuring from the start would
 * understate the drawdown of an account that is up overall.
 */
export function summariseCurve(points: readonly CurvePoint[]): CurveSummary {
  if (points.length === 0) return { ...EMPTY };

  let peak = points[0]!.equity;
  let worst = 0;
  let worstPct = 0;
  let current = 0;
  let currentPct = 0;

  for (const p of points) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak - p.equity;
    if (dd > worst) {
      worst = dd;
      worstPct = peak > 0 ? (dd / peak) * 100 : 0;
    }
    current = dd;
    currentPct = peak > 0 ? (dd / peak) * 100 : 0;
  }

  const first = points[0]!.equity;
  const last = points[points.length - 1]!.equity;

  return {
    start: points[0]!.time,
    end: points[points.length - 1]!.time,
    peak,
    worstDrawdown: worst,
    worstDrawdownPercent: worstPct,
    currentDrawdown: current,
    currentDrawdownPercent: currentPct,
    losing: last < first,
    points: points.length,
  };
}

/**
 * Downsample to at most `max` points, keeping the shape.
 *
 * A 5M-bar backtest cannot draw 5,000,000 points, and simply taking every Nth point hides
 * the spikes — which are the part worth seeing. This keeps the FIRST, the LAST, and the
 * extreme of each bucket, so a one-bar crash stays visible.
 */
export function downsampleCurve(
  points: readonly CurvePoint[],
  max = 2000,
): CurvePoint[] {
  if (points.length <= max || max < 3) return [...points];

  const bucketSize = points.length / Math.floor(max / 2);
  const out: CurvePoint[] = [points[0]!];

  let i = 1;
  while (i < points.length - 1) {
    const end = Math.min(points.length - 1, Math.floor(i + bucketSize));
    let lo = i;
    let hi = i;
    for (let j = i; j < end; j++) {
      if (points[j]!.equity < points[lo]!.equity) lo = j;
      if (points[j]!.equity > points[hi]!.equity) hi = j;
    }
    // emit the extremes in time order, so the drawn line never goes backwards in time
    if (lo === hi) {
      out.push(points[lo]!);
    } else if (lo < hi) {
      out.push(points[lo]!, points[hi]!);
    } else {
      out.push(points[hi]!, points[lo]!);
    }
    i = end;
  }

  out.push(points[points.length - 1]!);
  return out;
}

/** Convert a backtester's equity curve, which carries no balance field. */
export function fromBacktestEquity(points: readonly EquityPoint[]): CurvePoint[] {
  return points.map((p) => ({ time: p.time, equity: p.equity, balance: p.equity }));
}

/**
 * Build a curve from a starting balance and a list of realised trades.
 *
 * Used by the replay account, which does not sample equity per bar (that would be a second
 * source of truth for money). Each closed trade is a step; the flat stretches between trades
 * are implied by the chart, not materialised.
 */
export function fromTrades(
  startingBalance: number,
  trades: ReadonlyArray<{ exitTime: number; pnl: number }>,
): CurvePoint[] {
  if (trades.length === 0) {
    return [{ time: 0, equity: startingBalance, balance: startingBalance }];
  }
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let balance = startingBalance;
  const out: CurvePoint[] = [{ time: sorted[0]!.exitTime, equity: balance, balance }];
  for (const t of sorted) {
    balance += t.pnl;
    out.push({ time: t.exitTime, equity: balance, balance });
  }
  return out;
}

/** Format for the panel: money with a sign, and the drawdown as a percentage. */
export function describeCurve(s: CurveSummary): string {
  if (s.points === 0) return "no trades yet";
  const dd = s.worstDrawdownPercent > 0 ? ` · max DD ${s.worstDrawdownPercent.toFixed(1)}%` : "";
  const now = s.currentDrawdownPercent > 0 ? ` · now -${s.currentDrawdownPercent.toFixed(1)}%` : "";
  return `${s.points} points · peak ${s.peak.toFixed(2)}${dd}${now}`;
}
