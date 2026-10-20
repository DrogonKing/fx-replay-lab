/**
 * Explicit column mapping for CSV import, and a data-quality report.
 *
 * The importer detected the layout (timestamp-first vs date+time) and nothing else. A broker
 * export with a symbol column, a volume column before the close, or `Date;Time;Close;Open;...`
 * was rejected row by row with no explanation — the user got "0 bars imported" and no clue why.
 *
 * Mapping by name is what a user can actually do about it: point each field at a column.
 *
 * The quality report exists because a replay's whole value depends on the data being sound,
 * and a file with duplicated bars or weekend holes looks identical to a clean one until the
 * backtest gives nonsense.
 */
import type { Candle } from "./types.js";

/** Which column holds each field. -1 means "absent". */
export interface ColumnMap {
  time: number;
  /** separate time column for `date,time,O,H,L,C` exports; -1 when the time is in `time` */
  timeOfDay: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Field names a user can map, in display order. */
export const MAPPABLE: Array<keyof ColumnMap> = [
  "time", "timeOfDay", "open", "high", "low", "close", "volume",
];

const ALIASES: Record<keyof ColumnMap, string[]> = {
  time: ["date", "datetime", "timestamp", "time", "date_time", "dt", "gmt time", "local time"],
  timeOfDay: ["time", "clock", "tm"],
  open: ["open", "o", "bid open", "open price", "opening"],
  high: ["high", "h", "bid high", "high price", "max"],
  low: ["low", "l", "bid low", "low price", "min"],
  close: ["close", "c", "bid close", "close price", "last", "closing", "price"],
  volume: ["volume", "vol", "v", "tickvol", "tick volume", "real volume", "qty"],
};

/** Normalise a header cell for comparison: lowercase, trimmed, punctuation to a space. */
function norm(s: string): string {
  // Trailing punctuation leaves a space ("low." -> "low "), which then never matches an
  // alias. Collapse whitespace AND trim again afterwards.
  return s.toLowerCase().trim()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Map headers to fields.
 *
 * `time` and `timeOfDay` are the interesting case: MT4/MT5 exports have BOTH a date column and
 * a time column, and which one is which depends on the file. The rule: the first column that
 * matches a date-ish alias is `time`; a second time-ish column becomes `timeOfDay` only if it
 * is not already the timestamp.
 */
export function mapHeaders(headers: readonly string[]): ColumnMap {
  const map: ColumnMap = {
    time: -1, timeOfDay: -1, open: -1, high: -1, low: -1, close: -1, volume: -1,
  };
  const normed = headers.map(norm);

  // Pass 1: the unambiguous fields. First match wins, so a `close` before a `close price`
  // (there is none in practice) still resolves deterministically.
  for (const field of ["open", "high", "low", "close", "volume"] as const) {
    for (let i = 0; i < normed.length; i++) {
      if (ALIASES[field].includes(normed[i]!)) { map[field] = i; break; }
    }
  }

  // Pass 2: the timestamp. Prefer a column whose header says "date" or "datetime", because
  // a header literally called "time" in an MT5 export holds only the clock.
  const dateish = normed.findIndex((h) => h === "date" || h === "datetime"
    || h === "timestamp" || h === "date time" || h === "gmt time" || h === "local time");
  if (dateish >= 0) {
    map.time = dateish;
  } else {
    const timeish = normed.findIndex((h) => h === "time");
    if (timeish >= 0) map.time = timeish;
  }

  // A separate clock column, only if it is not the timestamp itself.
  for (let i = 0; i < normed.length; i++) {
    if (i === map.time) continue;
    if (normed[i] === "time" || normed[i] === "clock") { map.timeOfDay = i; break; }
  }

  // If the date and the clock were found in the SAME column, there is no split.
  if (map.timeOfDay === map.time) map.timeOfDay = -1;

  return map;
}

export interface MapCheck {
  ok: boolean;
  missing: string[];
  /** true when the map has a separate clock column, i.e. date+time split */
  split: boolean;
}

/** A map is usable when time, open, high, low and close are all present. */
export function checkMap(map: ColumnMap): MapCheck {
  const missing: string[] = [];
  if (map.time < 0) missing.push("time");
  for (const f of ["open", "high", "low", "close"] as const) {
    if (map[f] < 0) missing.push(f);
  }
  return { ok: missing.length === 0, missing, split: map.timeOfDay >= 0 };
}

/**
 * Apply a map to one row.
 *
 * Returns null for a row that cannot be read, so the caller counts it rather than throwing —
 * one malformed line in a 200,000-row export must not lose the file.
 */
export function rowFromMap(
  cols: readonly string[],
  map: ColumnMap,
  parseTime: (raw: string, timeOfDay?: string) => number | null,
): Candle | null {
  const at = (i: number): string => (i >= 0 ? (cols[i] ?? "") : "");
  const num = (i: number): number => {
    const raw = at(i).replace(/[\s,]/g, "");
    if (raw === "") return NaN;
    const n = Number(raw);
    return Number.isFinite(n) ? n : NaN;
  };

  const time = map.timeOfDay >= 0
    ? parseTime(at(map.time), at(map.timeOfDay))
    : parseTime(at(map.time));
  if (time == null) return null;

  const open = num(map.open);
  const high = num(map.high);
  const low = num(map.low);
  const close = num(map.close);
  if (![open, high, low, close].every(Number.isFinite)) return null;

  // a bar whose high is below its low, or which contains a price outside [low, high], is
  // corrupt: importing it silently bends every indicator that reads it
  if (high < low || high < open || high < close || low > open || low > close) return null;

  const vol = map.volume >= 0 ? num(map.volume) : 0;
  return { time, open, high, low, close, volume: Number.isFinite(vol) ? vol : 0 };
}

/** Problems worth telling the user about, most serious first. */
export type QualityIssueKind =
  | "duplicate_time"
  | "out_of_order"
  | "gap"
  | "inside_bar"
  | "zero_volume"
  | "identical_bars"
  | "non_positive_price";

export interface QualityIssue {
  kind: QualityIssueKind;
  count: number;
  /** up to three concrete examples, for the user to check against the source */
  examples: string[];
  /** how much this matters, for sorting */
  severity: "high" | "medium" | "low";
}

export interface QualityReport {
  bars: number;
  /** median spacing in seconds, from the data */
  spacing: number;
  from: number;
  to: number;
  issues: QualityIssue[];
  /** true when nothing serious was found */
  clean: boolean;
}

const DAY = 86_400;

/**
 * Inspect a parsed series.
 *
 * `expectedSpacing` is the timeframe the user believes they imported; a mismatch means the
 * aggregation is about to be wrong, which is worse than a few bad bars.
 */
export function auditCandles(candles: readonly Candle[], expectedSpacing?: number): QualityReport {
  if (candles.length === 0) {
    return { bars: 0, spacing: 0, from: 0, to: 0, issues: [], clean: true };
  }

  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const spacing = expectedSpacing ?? medianSpacing(sorted);

  const dup: string[] = [];
  let duplicates = 0;
  const ooo: string[] = [];
  let outOfOrder = 0;
  const gaps: string[] = [];
  let gapCount = 0;
  let insideBars = 0;
  let zeroVolume = 0;
  let identical = 0;
  let nonPositive = 0;
  const nonPositiveEx: string[] = [];

  const seen = new Set<number>();
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (seen.has(c.time)) {
      duplicates++;
      if (dup.length < 3) dup.push(iso(c.time));
    }
    seen.add(c.time);

    if (i > 0 && c.time < candles[i - 1]!.time) {
      outOfOrder++;
      if (ooo.length < 3) ooo.push(`${iso(candles[i - 1]!.time)} -> ${iso(c.time)}`);
    }

    // a bar whose body is entirely inside the previous bar's range: legal, but a sign the
    // file is a higher timeframe mislabelled as a lower one
    if (i > 0) {
      const p = candles[i - 1]!;
      if (c.high <= p.high && c.low >= p.low) insideBars++;
    }

    if (c.volume === 0) zeroVolume++;

    if (c.open === c.high && c.high === c.low && c.low === c.close) identical++;

    if (c.low <= 0 || c.open <= 0 || c.close <= 0) {
      nonPositive++;
      if (nonPositiveEx.length < 3) nonPositiveEx.push(`${iso(c.time)} low=${c.low}`);
    }

    if (i > 0 && spacing > 0) {
      const step = c.time - candles[i - 1]!.time;
      // a weekend gap is normal in FX; only flag a gap that is not a clean multiple, or one
      // longer than four days
      if (step > spacing * 1.5) {
        const multiple = step / spacing;
        const isWeekend = step >= DAY && step <= 4 * DAY;
        if (!isWeekend && Math.abs(multiple - Math.round(multiple)) > 0.01) {
          gapCount++;
          if (gaps.length < 3) gaps.push(`${iso(candles[i - 1]!.time)} -> ${iso(c.time)} (${Math.round(step / 60)}m)`);
        } else if (step > 4 * DAY) {
          gapCount++;
          if (gaps.length < 3) gaps.push(`${iso(candles[i - 1]!.time)} -> ${iso(c.time)} (${Math.round(step / DAY)}d)`);
        }
      }
    }
  }

  const issues: QualityIssue[] = [];
  const add = (
    kind: QualityIssueKind, count: number, examples: string[], severity: "high" | "medium" | "low",
  ): void => {
    if (count > 0) issues.push({ kind, count, examples, severity });
  };

  add("non_positive_price", nonPositive, nonPositiveEx, "high");
  add("duplicate_time", duplicates, dup, "high");
  add("out_of_order", outOfOrder, ooo, "medium");
  add("gap", gapCount, gaps, "medium");
  // zero volume on EVERY bar is normal for a CSV that has no volume column; only worth
  // reporting when some bars have volume and others do not
  if (zeroVolume > 0 && zeroVolume < candles.length) {
    add("zero_volume", zeroVolume, [], "low");
  }
  add("identical_bars", identical, [], identical > candles.length / 2 ? "high" : "low");
  // no examples: an inside bar is a pattern across the series, not a row to point at
  add("inside_bar", insideBars, [], "low");

  const order = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);

  return {
    bars: candles.length,
    spacing,
    from: sorted[0]!.time,
    to: sorted[sorted.length - 1]!.time,
    issues,
    clean: !issues.some((i) => i.severity === "high"),
  };
}

function medianSpacing(sorted: readonly Candle[]): number {
  if (sorted.length < 2) return 0;
  const steps: number[] = [];
  for (let i = 1; i < sorted.length; i++) steps.push(sorted[i]!.time - sorted[i - 1]!.time);
  steps.sort((a, b) => a - b);
  return steps[Math.floor(steps.length / 2)] ?? 0;
}

function iso(epoch: number): string {
  return new Date(epoch * 1000).toISOString().replace("T", " ").slice(0, 16);
}

const ISSUE_TEXT: Record<QualityIssueKind, { en: string; fa: string }> = {
  duplicate_time: { en: "duplicate timestamps", fa: "تایم‌استمپ تکراری" },
  out_of_order: { en: "rows out of order", fa: "ردیف‌های بی‌ترتیب" },
  gap: { en: "gaps in the series", fa: "شکاف در سری" },
  inside_bar: { en: "inside bars", fa: "کندل‌های داخلی" },
  zero_volume: { en: "bars with zero volume", fa: "کندل‌های با حجم صفر" },
  identical_bars: { en: "bars where O=H=L=C", fa: "کندل‌هایی با O=H=L=C" },
  non_positive_price: { en: "non-positive prices", fa: "قیمت‌های نامثبت" },
};

/** One line per issue, for the panel. */
export function describeQuality(report: QualityReport, lang: "en" | "fa" = "en"): string[] {
  if (report.bars === 0) {
    return [lang === "fa" ? "هیچ کندلی خوانده نشد" : "no bars were read"];
  }
  if (report.issues.length === 0) {
    return [lang === "fa"
      ? `${report.bars} کندل، بدون مشکل`
      : `${report.bars} bars, no problems found`];
  }
  return report.issues.map((i) => {
    const label = ISSUE_TEXT[i.kind][lang];
    const ex = i.examples.length > 0 ? ` (${i.examples[0]})` : "";
    return `${i.count} × ${label}${ex}`;
  });
}
