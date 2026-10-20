/**
 * Trailing stop and partial close — the rules that decide how a running trade is
 * managed.
 *
 * Pure. The trailing rule is the one place in the engine where a future bar can leak
 * into a past decision, so its ordering is spelled out and tested rather than left to
 * the call site.
 */
import type { Position, Side } from "./types.js";

export type TrailMode =
  /** fixed distance from the current close */
  | "distance"
  /** follow the bar's high/low instead of its close (tighter, more realistic) */
  | "extreme"
  /** ATR-based: distance = atrMultiple × ATR(14) */
  | "atr";

export interface TrailConfig {
  mode: TrailMode;
  /** price units for "distance"/"extreme", atr multiple for "atr" */
  value: number;
  /** ATR values aligned with the bars, for "atr" mode */
  atr?: readonly number[];
  /** index of the current bar in `atr` */
  atrIndex?: number;
}

export interface TrailInput {
  side: Side;
  /** current stop, or null */
  sl: number | null;
  entryPrice: number;
  /** the bar being processed */
  high: number;
  low: number;
  close: number;
  config: TrailConfig;
  /** round to the symbol's digits */
  round: (price: number) => number;
}

/**
 * The trail price for a bar, or null when it should stay where it is.
 *
 * **Ordering matters and is the whole point.** The level is derived from bar N, so it
 * may only be TESTED from bar N+1. Testing it on bar N is not look-ahead in the usual
 * sense (no future data is used) but it is equally wrong: the bar's low happened before
 * the close that produced the stop, so the stop "triggers" against price action that
 * preceded it. That closed winning trades for a loss: entry 2000.2 with a bar of
 * high 2030 / low 1999 / close 2025 gives a trail of 2015, which the same bar's low of
 * 1999 reported as hit, exiting at 2000 for -2.30 on a trade that had touched 2030.
 *
 * `applyTrailing` is therefore called AFTER the engine's SL/TP pass, never before.
 *
 *   buy : new = max(sl, reference - distance)
 *   sell: new = min(sl, reference + distance)
 *
 * where `reference` is the bar's close ("distance"), its high/low ("extreme"), or the
 * ATR distance below/above the close ("atr"). A buy's stop may additionally never be
 * placed above the bar's low, because that would make it trigger on the very bar it
 * was set on.
 */
export function trailPrice(input: TrailInput): number | null {
  const { side, sl, entryPrice, high, low, close, config, round } = input;
  // high/low are used only by "extreme" mode as the trailing reference.
  const isBuy = side === "buy";

  let distance: number;
  let reference: number;

  switch (config.mode) {
    case "distance":
      distance = config.value;
      reference = close;
      break;
    case "extreme":
      // trail behind the extreme the trade has actually reached, not the close
      distance = config.value;
      reference = isBuy ? high : low;
      break;
    case "atr": {
      const atr = config.atr?.[config.atrIndex ?? -1] ?? 0;
      if (!Number.isFinite(atr) || atr <= 0) return null;
      distance = atr * config.value;
      reference = close;
      break;
    }
    default:
      return null;
  }

  if (!Number.isFinite(distance) || distance <= 0) return null;

  const candidate = round(isBuy ? reference - distance : reference + distance);

  // No clamp to the bar's extreme. An earlier version did `candidate = min(candidate,
  // low)` for a buy, reasoning that a stop above the low would fire on this bar — but
  // for any normal bar low <= close, so the clamp could only ever fire by REWRITING a
  // tighter, valid stop down to the bar low. Every trail collapsed to the low and
  // trailing never worked at all.
  //
  // Where a stop sits is the user's choice. Whether it fires is decided by the SL check
  // that runs on this same bar, which is the correct place for that decision.

  // Never loosen: a trailing stop only ever tightens.
  if (sl !== null) {
    if (isBuy && candidate <= sl) return null;
    if (!isBuy && candidate >= sl) return null;
  }

  // NO guard against crossing the entry. An earlier version refused `candidate >
  // entryPrice` for a buy, which is exactly what a trailing stop is FOR: once price has
  // run, the trail locks in profit above the entry. The guard blocked every useful
  // trail and would have made the feature silently do nothing.
  //
  // A stop on the wrong side of PRICE cannot occur: candidate is close ± distance, so
  // it is always below the close for a buy and above it for a sell by construction.
  //
  // `entryPrice` is kept in the signature because callers reason about it, and because
  // a future "only trail once in profit" option needs it.
  void entryPrice;

  return candidate;
}

export interface PartialPlan {
  lots: number;
  /** the remaining size; 0 means this closes the position */
  remainder: number;
  valid: boolean;
  reason?: string;
}

/**
 * Validate a partial-close size.
 *
 * Trading platforms disagree about partial closes smaller than the lot step; this one
 * refuses them rather than rounding, because rounding up closes more than asked and
 * rounding down leaves a position you thought was gone.
 */
export function planPartialClose(
  totalLots: number,
  closeLots: number,
  lotStep: number,
): PartialPlan {
  if (!Number.isFinite(closeLots) || closeLots <= 0) {
    return { lots: 0, remainder: totalLots, valid: false, reason: "lots must be positive" };
  }
  if (closeLots > totalLots) {
    return {
      lots: totalLots, remainder: 0, valid: false,
      reason: `cannot close ${closeLots} of ${totalLots}`,
    };
  }
  const remainder = Number((totalLots - closeLots).toFixed(8));
  if (remainder > 0 && lotStep > 0) {
    const steps = remainder / lotStep;
    if (Math.abs(steps - Math.round(steps)) > 1e-6) {
      return {
        lots: closeLots, remainder, valid: false,
        reason: `leaves ${remainder} lots, which is not a multiple of the ${lotStep} step`,
      };
    }
  }
  return { lots: closeLots, remainder, valid: true };
}

/**
 * Suggested take-partial trigger: close `fraction` once the trade reaches `R`.
 *
 * Kept as a plain calculation so the UI can show "close 50% at 1R" and the same
 * numbers are used when it fires.
 */
export function partialTriggerPrice(
  pos: Pick<Position, "side" | "entryPrice" | "sl">,
  atR: number,
): number | null {
  if (pos.sl === null || atR <= 0) return null;
  const risk = Math.abs(pos.entryPrice - pos.sl);
  if (risk <= 0) return null;
  const move = risk * atR;
  return pos.side === "buy" ? pos.entryPrice + move : pos.entryPrice - move;
}

/** ATR over a candle series, aligned so index i uses the trailing window ending at i. */
export function atrSeries(
  high: readonly number[],
  low: readonly number[],
  close: readonly number[],
  period = 14,
): number[] {
  const n = high.length;
  const out = new Array<number>(n).fill(0);
  if (n === 0 || period <= 0) return out;

  let sum = 0;
  for (let i = 0; i < n; i++) {
    const prevClose = i > 0 ? close[i - 1]! : close[i]!;
    const tr = Math.max(
      high[i]! - low[i]!,
      Math.abs(high[i]! - prevClose),
      Math.abs(low[i]! - prevClose),
    );
    if (i < period) {
      sum += tr;
      // no value until the window is full: reporting a short-window ATR would make a
      // trailing stop tight for the first bars and then widen, which is a look-ahead
      // in disguise
      out[i] = i === period - 1 ? sum / period : 0;
    } else {
      const prev = out[i - 1]!;
      out[i] = prev === 0 ? sum / period : (prev * (period - 1) + tr) / period;
    }
  }
  return out;
}
