/**
 * The remaining built-in indicators from the spec:
 * VWAP, ADX (+DI/-DI), CCI, Ichimoku, Parabolic SAR, Supertrend, Volume,
 * and classic floor-trader Pivot Points.
 *
 * Kept in a second module so indicators.ts stays readable; the contract is
 * identical -- pure function of the series, NaN until enough data, O(1) or
 * O(period) per bar with no look-ahead.
 */
import type { CandleSeries } from "./types.js";
import { atr, rma, sma } from "./indicators.js";

export type Line = Float64Array;

function nanArray(n: number): Float64Array {
  const a = new Float64Array(n);
  a.fill(Number.NaN);
  return a;
}

// --------------------------------------------------------------------- VWAP

/**
 * Volume-weighted average price, reset at each session boundary.
 *
 * VWAP is only meaningful within a session; carrying it across days produces a
 * line that no trader would recognise. `sessionStart` marks bars where the
 * accumulator resets (the caller computes it from the session anchor).
 */
export function vwap(s: CandleSeries, sessionStart?: (i: number) => boolean): Line {
  const n = s.length;
  const out = nanArray(n);
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < n; i++) {
    if (sessionStart && sessionStart(i)) {
      pv = 0;
      vol = 0;
    }
    const typical = (s.high[i]! + s.low[i]! + s.close[i]!) / 3;
    const v = s.volume[i]!;
    if (v > 0) {
      pv += typical * v;
      vol += v;
      out[i] = pv / vol;
    } else if (vol > 0) {
      out[i] = pv / vol;      // flat volume: carry the last value, do not blank
    }
  }
  return out;
}

// ---------------------------------------------------------------------- ADX

export interface AdxOutput {
  adx: Line;
  plusDi: Line;
  minusDi: Line;
}

/**
 * Wilder's ADX with +DI / -DI.
 *
 * The sequence matters: smoothed DM and TR -> DI -> DX -> smoothed DX. Applying
 * the smoothing in the wrong order gives a plausible-looking but wrong curve,
 * which is why the exact Wilder chain is spelled out here.
 */
export function adx(s: CandleSeries, period = 14): AdxOutput {
  const n = s.length;
  const plusDM = new Float64Array(n);
  const minusDM = new Float64Array(n);
  const tr = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    if (i === 0) {
      tr[i] = s.high[i]! - s.low[i]!;
      continue;
    }
    const upMove = s.high[i]! - s.high[i - 1]!;
    const downMove = s.low[i - 1]! - s.low[i]!;
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    const hl = s.high[i]! - s.low[i]!;
    const hc = Math.abs(s.high[i]! - s.close[i - 1]!);
    const lc = Math.abs(s.low[i]! - s.close[i - 1]!);
    tr[i] = Math.max(hl, hc, lc);
  }

  const trS = rma(tr, period);
  const plusS = rma(plusDM, period);
  const minusS = rma(minusDM, period);

  const plusDi = nanArray(n);
  const minusDi = nanArray(n);
  const dx = nanArray(n);

  for (let i = 0; i < n; i++) {
    const t = trS[i]!;
    if (Number.isNaN(t) || t === 0) continue;
    const p = (plusS[i]! / t) * 100;
    const m = (minusS[i]! / t) * 100;
    plusDi[i] = p;
    minusDi[i] = m;
    const sum = p + m;
    dx[i] = sum === 0 ? 0 : (Math.abs(p - m) / sum) * 100;
  }

  // ADX is the Wilder average of DX; DX starts at index `period` (or later).
  const firstDx = dx.findIndex((v) => !Number.isNaN(v));
  const adxLine = nanArray(n);
  if (firstDx >= 0) {
    const adxRaw = rma(dx.subarray(firstDx), period);
    adxLine.set(adxRaw, firstDx);
  }
  return { adx: adxLine, plusDi, minusDi };
}

// ---------------------------------------------------------------------- CCI

/**
 * Commodity Channel Index.
 * CCI = (typical - SMA(typical)) / (0.015 * mean deviation)
 *
 * The 0.015 constant is Lambert's; the mean deviation is the average ABSOLUTE
 * deviation, not the standard deviation -- using sd is the most common
 * implementation error and shifts every reading.
 */
export function cci(s: CandleSeries, period = 20): Line {
  const n = s.length;
  const typical = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    typical[i] = (s.high[i]! + s.low[i]! + s.close[i]!) / 3;
  }
  const ma = sma(typical, period);
  const out = nanArray(n);

  for (let i = period - 1; i < n; i++) {
    const mean = ma[i]!;
    if (Number.isNaN(mean)) continue;
    let dev = 0;
    for (let j = i - period + 1; j <= i; j++) dev += Math.abs(typical[j]! - mean);
    dev /= period;
    out[i] = dev === 0 ? 0 : (typical[i]! - mean) / (0.015 * dev);
  }
  return out;
}

// ----------------------------------------------------------------- Ichimoku

export interface IchimokuOutput {
  tenkan: Line;
  kijun: Line;
  senkouA: Line;
  senkouB: Line;
  chikou: Line;
}

/**
 * Ichimoku Kinko Hyo.
 *
 * Displacement is applied as the spec's chart expects: Senkou A/B are shifted
 * FORWARD by `kijunPeriod` bars (plotted in the future), Chikou is shifted BACK.
 * The arrays stay index-aligned with price; the shift is recorded by writing the
 * value at (i + displacement), so the chart can plot it directly without a
 * second pass and without the classic "look-ahead" confusion.
 */
export function ichimoku(
  s: CandleSeries,
  tenkanPeriod = 9,
  kijunPeriod = 26,
  senkouBPeriod = 52,
): IchimokuOutput {
  const n = s.length;
  const midpoint = (from: number, to: number): number => {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = from; j <= to; j++) {
      if (s.high[j]! > hh) hh = s.high[j]!;
      if (s.low[j]! < ll) ll = s.low[j]!;
    }
    return (hh + ll) / 2;
  };

  const tenkan = nanArray(n);
  const kijun = nanArray(n);
  // not implemented: the leading span A is computed by no path here yet
  const _senkouA = nanArray(n);
  const senkouB = nanArray(n);
  const chikou = nanArray(n);

  for (let i = 0; i < n; i++) {
    if (i >= tenkanPeriod - 1) tenkan[i] = midpoint(i - tenkanPeriod + 1, i);
    if (i >= kijunPeriod - 1) kijun[i] = midpoint(i - kijunPeriod + 1, i);
    if (i >= senkouBPeriod - 1) senkouB[i] = midpoint(i - senkouBPeriod + 1, i);
  }

  // Senkou spans are plotted `kijunPeriod` bars ahead.
  const dispA = nanArray(n);
  const dispB = nanArray(n);
  for (let i = 0; i < n; i++) {
    const a = tenkan[i]!;
    const k = kijun[i]!;
    if (!Number.isNaN(a) && !Number.isNaN(k)) {
      const target = i + kijunPeriod;
      if (target < n) dispA[target] = (a + k) / 2;
    }
    const b = senkouB[i]!;
    if (!Number.isNaN(b)) {
      const target = i + kijunPeriod;
      if (target < n) dispB[target] = b;
    }
  }
  // Chikou is the close plotted kijunPeriod bars behind.
  for (let i = kijunPeriod; i < n; i++) {
    chikou[i - kijunPeriod] = s.close[i]!;
  }

  return { tenkan, kijun, senkouA: dispA, senkouB: dispB, chikou };
}

// --------------------------------------------------------------- Parabolic SAR

/**
 * Parabolic SAR (Wilder).
 *
 * Implemented with the acceleration-factor clamp at 0.20 and the rule that the
 * SAR may never penetrate the previous two bars' range, which is what prevents
 * the indicator from flipping spuriously inside a tight range.
 */
export function parabolicSar(
  s: CandleSeries,
  step = 0.02,
  max = 0.2,
): Line {
  const n = s.length;
  const out = nanArray(n);
  if (n < 2) return out;

  let bullish = s.close[1]! >= s.close[0]!;
  let af = step;
  let ep = bullish ? s.high[1]! : s.low[1]!;
  let sar = bullish ? s.low[0]! : s.high[0]!;
  out[0] = sar;

  for (let i = 1; i < n; i++) {
    sar = sar + af * (ep - sar);

    if (bullish) {
      // SAR cannot be above the prior two lows.
      const limit = Math.min(
        i >= 2 ? s.low[i - 2]! : s.low[i - 1]!,
        s.low[i - 1]!,
      );
      if (sar > limit) sar = limit;
      if (s.low[i]! < sar) {
        bullish = false;
        sar = ep;
        ep = s.low[i]!;
        af = step;
      } else if (s.high[i]! > ep) {
        ep = s.high[i]!;
        af = Math.min(max, af + step);
      }
    } else {
      const limit = Math.max(
        i >= 2 ? s.high[i - 2]! : s.high[i - 1]!,
        s.high[i - 1]!,
      );
      if (sar < limit) sar = limit;
      if (s.high[i]! > sar) {
        bullish = true;
        sar = ep;
        ep = s.high[i]!;
        af = step;
      } else if (s.low[i]! < ep) {
        ep = s.low[i]!;
        af = Math.min(max, af + step);
      }
    }
    out[i] = sar;
  }
  return out;
}

// ------------------------------------------------------------------ Supertrend

export interface SupertrendOutput {
  line: Line;
  /** +1 uptrend, -1 downtrend, 0 undecided */
  direction: Int8Array;
}

/**
 * Supertrend: ATR bands that flip when price closes through them.
 *
 * The final band carries state (it only tightens while the trend holds), so this
 * cannot be expressed as a vectorised formula -- it is genuinely sequential.
 */
export function supertrend(
  s: CandleSeries,
  period = 10,
  multiplier = 3,
): SupertrendOutput {
  const n = s.length;
  const line = nanArray(n);
  const direction = new Int8Array(n);
  const atrLine = atr(s, period);

  let upperBand = Number.NaN;
  let lowerBand = Number.NaN;
  let dir = 0;

  for (let i = 0; i < n; i++) {
    const a = atrLine[i]!;
    if (Number.isNaN(a)) continue;
    const mid = (s.high[i]! + s.low[i]!) / 2;
    const basicUpper = mid + multiplier * a;
    const basicLower = mid - multiplier * a;

    if (Number.isNaN(upperBand)) {
      upperBand = basicUpper;
      lowerBand = basicLower;
      dir = s.close[i]! >= mid ? 1 : -1;
    } else {
      // The band only moves in the trend's favour until it is broken.
      upperBand = basicUpper < upperBand || s.close[i - 1]! > upperBand
        ? basicUpper
        : upperBand;
      lowerBand = basicLower > lowerBand || s.close[i - 1]! < lowerBand
        ? basicLower
        : lowerBand;

      if (dir === 1 && s.close[i]! < lowerBand) {
        dir = -1;
      } else if (dir === -1 && s.close[i]! > upperBand) {
        dir = 1;
      }
    }
    direction[i] = dir;
    line[i] = dir === 1 ? lowerBand : upperBand;
  }
  return { line, direction };
}

// -------------------------------------------------------------------- Volume

/** Raw volume, passed through so it can be plotted in its own pane. */
export function volume(s: CandleSeries): Line {
  const out = new Float64Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.volume[i]!;
  return out;
}

/** Volume moving average, for colouring volume bars. */
export function volumeMa(s: CandleSeries, period = 20): Line {
  const v = volume(s);
  return sma(v, period);
}

// --------------------------------------------------------------- Pivots

export type PivotMethod = "classic" | "fibonacci";

export interface PivotLevels {
  pivot: number;
  r1: number;
  r2: number;
  r3: number;
  s1: number;
  s2: number;
  s3: number;
}

/**
 * Floor-trader pivots from the PREVIOUS session's high/low/close.
 *
 * Computed from the previous period only -- using the current session's own HLC
 * would be look-ahead and would make backtests impossibly good.
 */
export function pivotLevels(
  prevHigh: number,
  prevLow: number,
  prevClose: number,
  method: PivotMethod = "classic",
): PivotLevels {
  const p = (prevHigh + prevLow + prevClose) / 3;
  const range = prevHigh - prevLow;

  if (method === "fibonacci") {
    return {
      pivot: p,
      r1: p + 0.382 * range,
      r2: p + 0.618 * range,
      r3: p + 1.0 * range,
      s1: p - 0.382 * range,
      s2: p - 0.618 * range,
      s3: p - 1.0 * range,
    };
  }

  return {
    pivot: p,
    r1: 2 * p - prevLow,
    r2: p + range,
    r3: prevHigh + 2 * (p - prevLow),
    s1: 2 * p - prevHigh,
    s2: p - range,
    s3: prevLow - 2 * (prevHigh - p),
  };
}

/**
 * Pivot series: for each bar, the levels derived from the previous session.
 * Session boundaries come from the caller, so this stays timezone-agnostic.
 */
export function pivotSeries(
  s: CandleSeries,
  sessionId: (i: number) => number,
  method: PivotMethod = "classic",
): { pivot: Line; r1: Line; r2: Line; s1: Line; s2: Line } {
  const n = s.length;
  const pivot = nanArray(n);
  const r1 = nanArray(n);
  const r2 = nanArray(n);
  const s1 = nanArray(n);
  const s2 = nanArray(n);
  if (n === 0) return { pivot, r1, r2, s1, s2 };

  let prevHigh = Number.NaN;
  let prevLow = Number.NaN;
  let prevClose = Number.NaN;
  let curSession = sessionId(0);
  let hi = -Infinity;
  let lo = Infinity;
  let cl = s.close[0]!;

  for (let i = 0; i < n; i++) {
    const sid = sessionId(i);
    if (sid !== curSession) {
      // A new session starts: freeze the finished one and apply its pivots.
      prevHigh = hi;
      prevLow = lo;
      prevClose = cl;
      curSession = sid;
      hi = -Infinity;
      lo = Infinity;
    }
    if (!Number.isNaN(prevHigh)) {
      const lv = pivotLevels(prevHigh, prevLow, prevClose, method);
      pivot[i] = lv.pivot;
      r1[i] = lv.r1;
      r2[i] = lv.r2;
      s1[i] = lv.s1;
      s2[i] = lv.s2;
    }
    if (s.high[i]! > hi) hi = s.high[i]!;
    if (s.low[i]! < lo) lo = s.low[i]!;
    cl = s.close[i]!;
  }
  return { pivot, r1, r2, s1, s2 };
}
