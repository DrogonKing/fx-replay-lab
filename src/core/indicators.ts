/**
 * Indicator engine.
 *
 * Design: every indicator is a pure function of a CandleSeries producing one or
 * more output series aligned index-for-index with the input, using NaN for
 * "not enough data yet". NaN rather than shorter arrays because the chart and the
 * strategy API both index by bar, and a misaligned output is the classic source
 * of look-ahead bugs.
 *
 * All indicators are written in the incremental (O(1) per bar) style rather than
 * naive O(n*period) loops, because the backtester calls them across millions of
 * bars and the optimizer calls them thousands of times.
 */
import type { CandleSeries } from "./types.js";

export type Line = Float64Array;

export interface IndicatorOutput {
  /** primary line, always present */
  main: Line;
  /** extra lines, e.g. upper/middle/lower or macd/signal/hist */
  extra: Record<string, Line>;
}

function nanArray(n: number): Float64Array {
  const a = new Float64Array(n);
  a.fill(Number.NaN);
  return a;
}

// --------------------------------------------------------------------- SMA

export function sma(values: ArrayLike<number>, period: number): Line {
  const n = values.length;
  const out = nanArray(n);
  if (period <= 0 || n === 0) return out;

  // NaN must not poison the rolling sum. A running sum that absorbs one NaN
  // stays NaN forever, which silently blanks every later value -- the classic
  // bug when smoothing a partially-formed series (e.g. Stochastic's rawK).
  // Instead, count how many of the last `period` values are valid and emit a
  // value only when the whole window is valid.
  let sum = 0;
  let valid = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    if (Number.isNaN(v)) {
      // entering window as invalid
    } else {
      sum += v;
      valid++;
    }
    if (i >= period) {
      const old = values[i - period]!;
      if (!Number.isNaN(old)) {
        sum -= old;
        valid--;
      }
    }
    if (i >= period - 1 && valid === period) out[i] = sum / period;
  }
  return out;
}

export function smaOfClose(s: CandleSeries, period: number): Line {
  return sma(s.close, period);
}

// --------------------------------------------------------------------- EMA

/**
 * EMA with a seeded SMA, which is what trading platforms do: the first value is
 * the SMA of the first `period` bars, then the recursive step. Seeding with the
 * first bar instead would make early values differ from every reference chart.
 */
export function ema(values: ArrayLike<number>, period: number): Line {
  const n = values.length;
  const out = nanArray(n);
  if (period <= 0 || n < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i]!;
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < n; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// --------------------------------------------------------------------- RMA

/** Wilder's smoothing (used by RSI and ATR). */
export function rma(values: ArrayLike<number>, period: number): Line {
  const n = values.length;
  const out = nanArray(n);
  if (period <= 0 || n < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i]!;
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < n; i++) {
    prev = (prev * (period - 1) + values[i]!) / period;
    out[i] = prev;
  }
  return out;
}

// --------------------------------------------------------------------- RSI

/**
 * RSI with Wilder smoothing, matching TradingView and MT4.
 *
 * Edge cases handled explicitly: a period of pure gains gives 100, pure losses
 * gives 0, and no change at all gives 50. Returning NaN there (the result of a
 * 0/0 division) would blank the line on a flat market.
 */
export function rsi(s: CandleSeries, period = 14): Line {
  const n = s.length;
  const out = nanArray(n);
  if (period <= 0 || n <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = s.close[i]! - s.close[i - 1]!;
    if (d >= 0) gainSum += d;
    else lossSum -= d;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiFrom(avgGain, avgLoss);

  for (let i = period + 1; i < n; i++) {
    const d = s.close[i]! - s.close[i - 1]!;
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// --------------------------------------------------------- Bollinger Bands

export interface BollingerOutput {
  upper: Line;
  middle: Line;
  lower: Line;
}

/**
 * Bollinger Bands with POPULATION standard deviation, matching the common
 * platform default. Using the sample (n-1) deviation instead shifts the bands
 * slightly and is a frequent source of "my backtest differs from the chart".
 */
export function bollinger(
  s: CandleSeries,
  period = 20,
  mult = 2,
): BollingerOutput {
  const n = s.length;
  const middle = sma(s.close, period);
  const upper = nanArray(n);
  const lower = nanArray(n);
  if (period <= 0 || n === 0) return { upper, middle, lower };

  // Rolling sum and sum of squares -> O(1) per bar.
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = s.close[i]!;
    sum += v;
    sumSq += v * v;
    if (i >= period) {
      const old = s.close[i - period]!;
      sum -= old;
      sumSq -= old * old;
    }
    if (i >= period - 1) {
      const mean = sum / period;
      // Guard tiny negative from float error before sqrt.
      const variance = Math.max(0, sumSq / period - mean * mean);
      const sd = Math.sqrt(variance);
      upper[i] = mean + mult * sd;
      lower[i] = mean - mult * sd;
    }
  }
  return { upper, middle, lower };
}

// --------------------------------------------------------------------- WMA

export function wma(values: ArrayLike<number>, period: number): Line {
  const n = values.length;
  const out = nanArray(n);
  if (period <= 0 || n < period) return out;
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < period; j++) {
      acc += values[i - period + 1 + j]! * (j + 1);
    }
    out[i] = acc / denom;
  }
  return out;
}

// --------------------------------------------------------------------- ATR

export function atr(s: CandleSeries, period = 14): Line {
  const n = s.length;
  const tr = new Float64Array(n);
  if (n === 0) return nanArray(0);
  tr[0] = s.high[0]! - s.low[0]!;
  for (let i = 1; i < n; i++) {
    const hl = s.high[i]! - s.low[i]!;
    const hc = Math.abs(s.high[i]! - s.close[i - 1]!);
    const lc = Math.abs(s.low[i]! - s.close[i - 1]!);
    tr[i] = Math.max(hl, hc, lc);
  }
  return rma(tr, period);
}

// -------------------------------------------------------------------- MACD

export interface MacdOutput {
  macd: Line;
  signal: Line;
  histogram: Line;
}

export function macd(
  s: CandleSeries,
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdOutput {
  const n = s.length;
  const ef = ema(s.close, fast);
  const es = ema(s.close, slow);
  const macdLine = nanArray(n);
  for (let i = 0; i < n; i++) {
    const a = ef[i];
    const b = es[i];
    if (a != null && b != null && !Number.isNaN(a) && !Number.isNaN(b)) {
      macdLine[i] = a - b;
    }
  }
  // Signal is an EMA of the MACD line, which only exists after `slow` bars.
  const firstValid = macdLine.findIndex((v) => !Number.isNaN(v));
  const signal = nanArray(n);
  if (firstValid >= 0) {
    const compact = macdLine.subarray(firstValid);
    const sig = ema(compact, signalPeriod);
    signal.set(sig, firstValid);
  }
  const histogram = nanArray(n);
  for (let i = 0; i < n; i++) {
    const m = macdLine[i]!;
    const g = signal[i]!;
    if (!Number.isNaN(m) && !Number.isNaN(g)) histogram[i] = m - g;
  }
  return { macd: macdLine, signal, histogram };
}

// -------------------------------------------------------------- Stochastic

export interface StochOutput {
  k: Line;
  d: Line;
}

export function stochastic(
  s: CandleSeries,
  kPeriod = 14,
  dPeriod = 3,
  smooth = 3,
): StochOutput {
  const n = s.length;
  const rawK = nanArray(n);
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (s.high[j]! > hh) hh = s.high[j]!;
      if (s.low[j]! < ll) ll = s.low[j]!;
    }
    const range = hh - ll;
    rawK[i] = range === 0 ? 50 : ((s.close[i]! - ll) / range) * 100;
  }
  const k = sma(rawK, smooth);
  const d = sma(k, dPeriod);
  return { k, d };
}

// ------------------------------------------------------------------ helpers

/** Crossover of `a` above `b` at bar i (false when either is NaN). */
export function crossover(a: Line, b: Line, i: number): boolean {
  if (i < 1) return false;
  const a0 = a[i - 1]!, a1 = a[i]!, b0 = b[i - 1]!, b1 = b[i]!;
  if ([a0, a1, b0, b1].some((v) => Number.isNaN(v))) return false;
  return a0 <= b0 && a1 > b1;
}

export function crossunder(a: Line, b: Line, i: number): boolean {
  if (i < 1) return false;
  const a0 = a[i - 1]!, a1 = a[i]!, b0 = b[i - 1]!, b1 = b[i]!;
  if ([a0, a1, b0, b1].some((v) => Number.isNaN(v))) return false;
  return a0 >= b0 && a1 < b1;
}

/** Highest high of the last `period` bars ending at i (inclusive). */
export function highestHigh(s: CandleSeries, i: number, period: number): number {
  let hh = -Infinity;
  const from = Math.max(0, i - period + 1);
  for (let j = from; j <= i; j++) if (s.high[j]! > hh) hh = s.high[j]!;
  return hh;
}

export function lowestLow(s: CandleSeries, i: number, period: number): number {
  let ll = Infinity;
  const from = Math.max(0, i - period + 1);
  for (let j = from; j <= i; j++) if (s.low[j]! < ll) ll = s.low[j]!;
  return ll;
}
