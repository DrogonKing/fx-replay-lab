/**
 * CandleSeries construction and access helpers.
 *
 * Columnar storage keeps 5M bars at ~240 MB instead of ~1.2 GB of objects.
 * Everything here is allocation-light and copy-free where possible.
 */
import type { Candle, CandleSeries } from "./types.js";

export function emptySeries(): CandleSeries {
  const a = new Float64Array(0);
  return { time: a, open: a, high: a, low: a, close: a, volume: a, length: 0 };
}

/** Build a series from plain candles. Ensures ascending time. */
export function seriesFromCandles(candles: readonly Candle[]): CandleSeries {
  const n = candles.length;
  const s: CandleSeries = {
    time: new Float64Array(n),
    open: new Float64Array(n),
    high: new Float64Array(n),
    low: new Float64Array(n),
    close: new Float64Array(n),
    volume: new Float64Array(n),
    length: n,
  };
  for (let i = 0; i < n; i++) {
    const c = candles[i]!;
    s.time[i] = c.time;
    s.open[i] = c.open;
    s.high[i] = c.high;
    s.low[i] = c.low;
    s.close[i] = c.close;
    s.volume[i] = c.volume;
  }
  if (!isAscending(s.time, n)) {
    throw new Error("seriesFromCandles: candles are not sorted by time");
  }
  return s;
}

export function isAscending(time: Float64Array, n: number): boolean {
  for (let i = 1; i < n; i++) if (time[i]! <= time[i - 1]!) return false;
  return true;
}

/** View of [from, to) without copying. */
export function sliceSeries(s: CandleSeries, from: number, to: number): CandleSeries {
  const a = Math.max(0, from);
  const b = Math.min(s.length, to);
  const n = Math.max(0, b - a);
  return {
    time: s.time.subarray(a, a + n),
    open: s.open.subarray(a, a + n),
    high: s.high.subarray(a, a + n),
    low: s.low.subarray(a, a + n),
    close: s.close.subarray(a, a + n),
    volume: s.volume.subarray(a, a + n),
    length: n,
  };
}

export function candleAt(s: CandleSeries, i: number): Candle | null {
  if (i < 0 || i >= s.length) return null;
  return {
    time: s.time[i]!,
    open: s.open[i]!,
    high: s.high[i]!,
    low: s.low[i]!,
    close: s.close[i]!,
    volume: s.volume[i]!,
  };
}

/** Byte size of the column arrays, for the data-quality report. */
export function seriesByteSize(s: CandleSeries): number {
  return s.length * 8 * 6;
}
