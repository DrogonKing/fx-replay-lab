/**
 * Timeframe aggregation.
 *
 * Two modes, and they are genuinely different problems:
 *
 * 1. MINUTE frames (M5, M15, H1, H4, and odd ones like 7 or 90 minutes).
 *    Bars are bucketed by `floor(time / (minutes*60))` so a 7-minute frame is a
 *    first-class citizen, not an approximation of something else. Buckets are
 *    anchored to the UTC epoch, which makes every frame deterministic and
 *    reproducible -- the same input always yields the same output.
 *
 * 2. DAY and WEEK frames.
 *    These must NOT use epoch bucketing, because a forex "day" ends at the
 *    broker's roll (default 17:00 New York, see ADR-004), which is 21:00 or
 *    22:00 UTC depending on DST. Bucketing to UTC midnight would produce daily
 *    candles that disagree with every broker chart. So day bars are grouped by
 *    the local calendar date in the chosen anchor zone, computed per bar.
 *
 * Aggregation always reads from the SMALLEST loaded base series, never from an
 * already-aggregated frame, to avoid compounding rounding.
 */
import type { CandleSeries, Timeframe } from "./types.js";
import { toWallClock } from "./timezone.js";

export const TIMEFRAMES: Timeframe[] = [
  { label: "M1", minutes: 1, kind: "minute" },
  { label: "M5", minutes: 5, kind: "minute" },
  { label: "M15", minutes: 15, kind: "minute" },
  { label: "M30", minutes: 30, kind: "minute" },
  { label: "H1", minutes: 60, kind: "minute" },
  { label: "H4", minutes: 240, kind: "minute" },
  { label: "D1", minutes: 0, kind: "day" },
  { label: "W1", minutes: 0, kind: "week" },
];

export function parseTimeframeLabel(label: string): Timeframe | null {
  const preset = TIMEFRAMES.find((t) => t.label.toUpperCase() === label.toUpperCase());
  if (preset) return preset;
  const m = /^(\d+)$/.exec(label.trim());
  if (m) {
    const minutes = Number(m[1]);
    if (minutes > 0) return { label: `${minutes}m`, minutes, kind: "minute" };
  }
  return null;
}

export interface AggregateOptions {
  /** IANA zone whose calendar defines day/week boundaries. Default New York. */
  anchorZone?: string;
  /** wall-clock hour (0-23) in anchorZone where the trading day rolls */
  sessionOpenHour?: number;
}

/**
 * Bucket key for a timestamp, given a frame.
 * Minute frames -> integer index. Day/week -> a comparable calendar key.
 */
function bucketKey(
  time: number,
  tf: Timeframe,
  anchorZone: string,
  sessionOpenHour: number,
): number {
  if (tf.kind === "minute") {
    const step = tf.minutes * 60;
    return Math.floor(time / step);
  }
  // Shift by the session open so the local calendar date changes at the roll.
  const w = toWallClock(time, anchorZone);
  let dayIndex = Math.floor(
    Date.UTC(w.year, w.month - 1, w.day) / 86_400_000,
  );
  if (w.hour < sessionOpenHour) dayIndex -= 1;

  if (tf.kind === "week") {
    // ISO-ish week: Monday starts a new week.
    const weekday = new Date(dayIndex * 86_400_000).getUTCDay(); // 0=Sun
    const daysFromMonday = (weekday + 6) % 7;
    return Math.floor((dayIndex - daysFromMonday) / 7);
  }
  return dayIndex;
}

/** Timestamp label for the first bar of a bucket (used as the bar's open time). */
function bucketStart(
  time: number,
  tf: Timeframe,
): number {
  if (tf.kind === "minute") {
    const step = tf.minutes * 60;
    return Math.floor(time / step) * step;
  }
  return time;
}

/**
 * Aggregate `base` into `tf`.
 *
 * OHLC rule per bucket: open = first bar's open, close = last bar's close,
 * high = max, low = min, volume = sum. Buckets with no data produce no bar
 * (gaps are not filled) -- filling them would invent prices that never traded.
 */
export function aggregate(
  base: CandleSeries,
  tf: Timeframe,
  opts: AggregateOptions = {},
): CandleSeries {
  const anchorZone = opts.anchorZone ?? "America/New_York";
  const sessionOpenHour = opts.sessionOpenHour ?? 17;
  const n = base.length;
  if (n === 0) {
    const a = new Float64Array(0);
    return { time: a, open: a, high: a, low: a, close: a, volume: a, length: 0 };
  }

  // Count buckets first so the output arrays are allocated exactly once.
  let count = 0;
  let prevKey = Number.NaN;
  for (let i = 0; i < n; i++) {
    const k = bucketKey(base.time[i]!, tf, anchorZone, sessionOpenHour);
    if (k !== prevKey) {
      count++;
      prevKey = k;
    }
  }

  const out: CandleSeries = {
    time: new Float64Array(count),
    open: new Float64Array(count),
    high: new Float64Array(count),
    low: new Float64Array(count),
    close: new Float64Array(count),
    volume: new Float64Array(count),
    length: count,
  };

  let w = -1;
  prevKey = Number.NaN;
  for (let i = 0; i < n; i++) {
    const t = base.time[i]!;
    const k = bucketKey(t, tf, anchorZone, sessionOpenHour);
    const o = base.open[i]!;
    const h = base.high[i]!;
    const l = base.low[i]!;
    const c = base.close[i]!;
    const v = base.volume[i]!;

    if (k !== prevKey) {
      w++;
      out.time[w] = bucketStart(t, tf);
      out.open[w] = o;
      out.high[w] = h;
      out.low[w] = l;
      out.close[w] = c;
      out.volume[w] = v;
      prevKey = k;
    } else {
      if (h > out.high[w]!) out.high[w] = h;
      if (l < out.low[w]!) out.low[w] = l;
      out.close[w] = c;
      out.volume[w] = (out.volume[w] ?? 0) + v;
    }
  }
  return out;
}

/**
 * The live "forming" bar for a replay position: aggregate only the base bars
 * revealed so far within the current bucket, so the higher-timeframe candle
 * grows visibly as base bars arrive (spec requirement).
 */
export function aggregateForming(
  base: CandleSeries,
  revealedCount: number,
  tf: Timeframe,
  opts: AggregateOptions = {},
): CandleSeries {
  const upTo = Math.max(0, Math.min(base.length, revealedCount));
  const anchorZone = opts.anchorZone ?? "America/New_York";
  const sessionOpenHour = opts.sessionOpenHour ?? 17;
  if (upTo === 0) return aggregate(base, tf, opts);

  const lastKey = bucketKey(base.time[upTo - 1]!, tf, anchorZone, sessionOpenHour);
  // Walk back to the first bar of the forming bucket.
  let start = upTo - 1;
  while (start > 0) {
    const k = bucketKey(base.time[start - 1]!, tf, anchorZone, sessionOpenHour);
    if (k !== lastKey) break;
    start--;
  }
  // Aggregate everything up to the bucket start as closed bars, then append the
  // forming bar computed from the partial bucket.
  const closed = aggregate(
    {
      ...base,
      time: base.time.subarray(0, start),
      open: base.open.subarray(0, start),
      high: base.high.subarray(0, start),
      low: base.low.subarray(0, start),
      close: base.close.subarray(0, start),
      volume: base.volume.subarray(0, start),
      length: start,
    },
    tf,
    opts,
  );

  let hi = -Infinity;
  let lo = Infinity;
  let vol = 0;
  for (let i = start; i < upTo; i++) {
    if (base.high[i]! > hi) hi = base.high[i]!;
    if (base.low[i]! < lo) lo = base.low[i]!;
    vol += base.volume[i]!;
  }

  const len = closed.length + 1;
  const out: CandleSeries = {
    time: new Float64Array(len),
    open: new Float64Array(len),
    high: new Float64Array(len),
    low: new Float64Array(len),
    close: new Float64Array(len),
    volume: new Float64Array(len),
    length: len,
  };
  out.time.set(closed.time);
  out.open.set(closed.open);
  out.high.set(closed.high);
  out.low.set(closed.low);
  out.close.set(closed.close);
  out.volume.set(closed.volume);

  out.time[closed.length] = bucketStart(base.time[start]!, tf);
  out.open[closed.length] = base.open[start]!;
  out.high[closed.length] = hi;
  out.low[closed.length] = lo;
  out.close[closed.length] = base.close[upTo - 1]!;
  out.volume[closed.length] = vol;
  return out;
}

/** Median spacing of the first N bars, used to detect a CSV's base timeframe. */
export function detectBaseTimeframeMinutes(base: CandleSeries, sample = 200): number {
  const n = Math.min(base.length - 1, sample);
  if (n <= 0) return 0;
  const diffs: number[] = [];
  for (let i = 1; i <= n; i++) {
    const d = base.time[i]! - base.time[i - 1]!;
    // Ignore weekend gaps when detecting intraday spacing.
    if (d > 0 && d <= 4 * 3600) diffs.push(d);
  }
  if (diffs.length === 0) return 0;
  diffs.sort((a, b) => a - b);
  const mid = Math.floor(diffs.length / 2);
  const median = diffs.length % 2 === 1
    ? diffs[mid]!
    : (diffs[mid - 1]! + diffs[mid]!) / 2;
  return median / 60;
}
