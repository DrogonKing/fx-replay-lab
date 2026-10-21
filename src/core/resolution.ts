/**
 * What resolution is this series actually in?
 *
 * The app has four ways data arrives — provider, file import, Dukascopy download, broker — and
 * not all of them can report their interval. Rather than thread a parameter through every path
 * (and have one of them lie), the resolution is read from the data itself: the most common gap
 * between consecutive bars is the bar length.
 *
 * This matters because every higher timeframe is built by aggregating the base, and aggregating
 * 5-minute bars as if they were 1-minute bars produces candles with a fifth of the range.
 */
import type { CandleSeries, Timeframe } from "./types.js";
import { TIMEFRAMES } from "./aggregate.js";

/**
 * The most common gap between bars, in seconds.
 *
 * Uses the MODE, not the mean: weekends and holidays are huge gaps, and an average over a month
 * of 1-minute data would be dragged upward by every closed session. The mode is the normal bar
 * spacing, which is what we want.
 */
export function detectSpacingSeconds(series: CandleSeries): number | null {
  const n = series.length;
  if (n < 3) return null;

  const counts = new Map<number, number>();
  // sample at most 5000 gaps across the whole series: enough for a stable mode, cheap on 30k bars
  const stride = Math.max(1, Math.floor((n - 1) / 5000));
  for (let i = stride; i < n; i += stride) {
    const d = series.time[i]! - series.time[i - stride]!;
    if (d <= 0) continue;
    // normalise back to a per-bar gap when we are sampling with a stride
    const per = Math.round(d / stride);
    if (per <= 0) continue;
    counts.set(per, (counts.get(per) ?? 0) + 1);
  }

  let best: number | null = null;
  let bestCount = 0;
  for (const [gap, count] of Array.from(counts.entries())) {
    if (count > bestCount) { bestCount = count; best = gap; }
  }
  return best;
}

/**
 * The timeframe a series is in.
 *
 * Returns null when the spacing does not match a known frame — an odd export with a 90-second
 * bar, say. Callers must handle null by refusing to derive higher frames, because guessing here
 * silently corrupts every aggregate above it.
 */
export function detectTimeframe(series: CandleSeries): Timeframe | null {
  const sec = detectSpacingSeconds(series);
  if (sec === null) return null;

  if (sec >= 6 * 86400 && sec <= 8 * 86400) {
    return TIMEFRAMES.find((t) => t.kind === "week") ?? null;
  }
  if (sec >= 20 * 3600 && sec <= 28 * 3600) {
    return TIMEFRAMES.find((t) => t.kind === "day") ?? null;
  }
  const minutes = Math.round(sec / 60);
  const known = TIMEFRAMES.find((t) => t.kind === "minute" && t.minutes === minutes);
  if (known) return known;
  // an unusual but valid intraday spacing: a real frame, just not a preset
  if (minutes >= 1 && minutes <= 1440) {
    return { label: `${minutes}m`, minutes, kind: "minute" };
  }
  return null;
}

/** Frames at or above `base`, for the toolbar. Always includes the base itself. */
export function framesAtOrAbove(base: Timeframe | null): Timeframe[] {
  if (base === null) return TIMEFRAMES;
  // canAggregate is the single rule for "can this frame be built"; an earlier version of this
  // function compared minutes inline and only when both frames were intraday, which left a daily
  // base still offering M1/M5/H1 — frames it cannot possibly produce.
  const out = TIMEFRAMES.filter((tf) => canAggregate(base, tf));
  // a custom base (e.g. 7m) is not in the presets, so make sure it is selectable
  if (!out.some((tf) => tf.label === base.label)) {
    out.unshift(base);
  }
  return out;
}

/**
 * Can `tf` be built from a base of `base`?
 *
 * Aggregating 1-minute bars into 1-minute bars is a no-op; aggregating 5-minute bars into
 * 1-minute bars is impossible. This is the check that stops the toolbar offering a lie.
 */
export function canAggregate(base: Timeframe | null, tf: Timeframe): boolean {
  if (base === null) return tf.label === TIMEFRAMES[0]!.label;
  if (base.kind === "week") return tf.kind === "week";
  if (base.kind === "day") return tf.kind === "day" || tf.kind === "week";
  // base is intraday
  if (tf.kind !== "minute") return true; // day/week are always higher
  return tf.minutes >= base.minutes;
}

/**
 * A hint for the UI when a frame cannot be built.
 *
 * Saying "not available" is useless; saying which data would make it available is actionable.
 */
export function explainUnavailable(base: Timeframe | null, tf: Timeframe): string {
  if (base === null) {
    return "load some data first — the bar length could not be detected";
  }
  return (
    `${tf.label} cannot be built from ${base.label} bars. ` +
    `Load ${tf.label} or smaller data to see this frame.`
  );
}
