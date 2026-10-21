/**
 * Import data the user already has on disk.
 *
 * People arrive with a pile of downloaded history in whatever format their source produced,
 * and asking them to convert it first is where the app loses them. So this sniffs the format
 * instead of demanding one: Dukascopy .bi5, HistData monthly ZIPs, MT4/MT5 exports, TrueFX,
 * and plain CSV all land in the same Candle[].
 *
 * Pure. The main process reads bytes; everything that decides what those bytes MEAN is here,
 * so it is testable without a filesystem.
 */
import type { Candle } from "./types.js";
import { decodeCandles, pointScale, type DukaBar } from "./dukascopy.js";

export type SourceFormat =
  | "dukascopy-bi5"
  | "histdata-ascii"
  | "mt4-export"
  | "truefx"
  | "generic-csv"
  | "unknown";

export interface DetectedFile {
  format: SourceFormat;
  /** what the sniffer saw, shown to the user so a wrong guess is visible */
  reason: string;
}

/**
 * Identify a file from its bytes and name.
 *
 * Order matters: the specific formats are checked before the generic CSV, because a HistData
 * file IS a CSV and would otherwise be parsed with the wrong column meanings.
 */
export function detectFormat(name: string, head: Uint8Array): DetectedFile {
  const lower = name.toLowerCase();

  // .bi5 is LZMA-compressed Dukascopy. The magic bytes are not fixed, so the extension is
  // the only reliable signal — but the caller decompresses before parsing anyway.
  if (lower.endsWith(".bi5")) {
    return { format: "dukascopy-bi5", reason: "Dukascopy .bi5 file" };
  }
  if (lower.endsWith(".zip")) {
    // HistData ships monthly ZIPs; the name usually carries the pair and month
    return { format: "histdata-ascii", reason: "zip archive (HistData monthly export)" };
  }

  const text = decodeHead(head, 4000);
  const firstLine = text.split(/\r?\n/)[0] ?? "";

  // HistData M1 ASCII: "20240101 000000;1.10366;1.10374;1.10366;1.10376;0"
  // semicolons, no header, date and time in ONE field with no separator
  if (/^\d{8} \d{6};/.test(firstLine)) {
    return { format: "histdata-ascii", reason: "date-time;O;H;L;C;V with semicolons" };
  }

  // TrueFX: "EURUSD,20240101 00:00:00.123,1.10366,1.10374"
  if (/^[A-Z]{6},\d{8} \d{2}:\d{2}:\d{2}\.\d+/.test(firstLine)) {
    return { format: "truefx", reason: "SYMBOL,datetime with milliseconds,bid,ask" };
  }

  // MT4/MT5 export: "<DATE>\t<TIME>\t<OPEN>..." or comma, with a header row
  if (/date/i.test(firstLine) && /(open|high|low|close|price)/i.test(firstLine)) {
    return { format: "mt4-export", reason: "header row naming date and OHLC" };
  }
  if (/^\d{4}[.\-/]\d{2}[.\-/]\d{2}[,\t]/.test(firstLine)) {
    return { format: "mt4-export", reason: "date-first rows with no header" };
  }

  if (/,|;|\t/.test(firstLine) && /\d/.test(firstLine)) {
    return { format: "generic-csv", reason: "delimited numbers" };
  }

  return { format: "unknown", reason: "no recognisable structure" };
}

function decodeHead(bytes: Uint8Array, limit: number): string {
  const slice = bytes.subarray(0, Math.min(limit, bytes.byteLength));
  return new TextDecoder("utf-8", { fatal: false }).decode(slice);
}

/** Split a line on whichever delimiter it actually uses. */
function splitRow(line: string): string[] {
  if (line.includes(";")) return line.split(";");
  if (line.includes("\t")) return line.split("\t");
  if (line.includes(",")) return line.split(",");
  return line.split(/\s+/);
}

/** "20240101" + "000000" -> epoch seconds, or null. */
function parseCompact(dateStr: string, timeStr: string): number | null {
  const dm = /^(\d{4})(\d{2})(\d{2})$/.exec(dateStr.trim());
  if (!dm) return null;
  const tm = /^(\d{2}):?(\d{2}):?(\d{2})/.exec(timeStr.trim());
  if (!tm) return null;
  const [, y, mo, d] = dm;
  const [, h, mi, s] = tm;
  return Date.UTC(
    Number(y), Number(mo) - 1, Number(d),
    Number(h), Number(mi), Number(s),
  ) / 1000;
}

/** "2024.01.02" / "2024-01-02" / "2024/01/02" + "10:00[:00]" -> epoch seconds. */
function parseLoose(dateStr: string, timeStr: string): number | null {
  const dm = /^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})$/.exec(dateStr.trim());
  if (!dm) return null;
  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(timeStr.trim());
  const [, y, mo, d] = dm;
  const h = tm ? Number(tm[1]) : 0;
  const mi = tm ? Number(tm[2]) : 0;
  const s = tm && tm[3] ? Number(tm[3]) : 0;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), h, mi, s) / 1000;
}

/** ISO 8601, with or without a trailing Z. */
function parseIso(s: string): number | null {
  const t = Date.parse(s.replace(" ", "T"));
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

export interface ParseResult {
  candles: Candle[];
  /** rows rejected, with a reason count — so a bad file is diagnosable */
  skipped: number;
  /** the format actually used */
  format: SourceFormat;
  /** first and last bar times, for a sanity check in the UI */
  firstTime: number | null;
  lastTime: number | null;
  errors: string[];
}

/**
 * Parse a text file of candles.
 *
 * `utcOffsetHours` shifts the timestamps: brokers export in their server time, and a broker on
 * GMT+2 would otherwise produce a chart shifted by two hours — which silently breaks every
 * session-based calculation.
 */
export function parseText(
  name: string,
  text: string,
  utcOffsetHours = 0,
): ParseResult {
  const det = detectFormat(name, new TextEncoder().encode(text.slice(0, 4000)));
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const candles: Candle[] = [];
  const errors: string[] = [];
  let skipped = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    const cols = splitRow(line);

    // A header can only be the FIRST line. An earlier version skipped any non-numeric line,
    // which silently ate a corrupt row in the middle of a file and reported zero problems —
    // the worst kind of failure, because the file looked clean.
    if (lineIndex === 0 && det.format === "mt4-export" &&
        /[a-z]/i.test(line) && !/^\d/.test(line.trim())) {
      continue;
    }

    let time: number | null = null;
    let o = NaN;
    let h = NaN;
    let l = NaN;
    let c = NaN;
    let v = 0;

    if (det.format === "histdata-ascii") {
      // 20240101 000000;O;H;L;C;V
      const [dt, ...rest] = cols;
      if (dt && rest.length >= 4) {
        const [datePart, timePart] = dt.trim().split(" ");
        time = datePart && timePart ? parseCompact(datePart, timePart) : null;
        o = Number(rest[0]);
        h = Number(rest[1]);
        l = Number(rest[2]);
        c = Number(rest[3]);
        v = rest[4] !== undefined ? Number(rest[4]) : 0;
      }
    } else if (det.format === "truefx") {
      // EURUSD,20240101 00:00:00.123,1.10366,1.10374  -> bid/ask ticks, not candles
      const [, dt, bid, ask] = cols;
      if (dt && bid && ask) {
        time = parseCompact(dt.trim().slice(0, 8), dt.trim().slice(9, 17).replace(/\./g, ""));
        // a tick has no OHLC: use the mid as all four so it becomes a flat bar
        const mid = (Number(bid) + Number(ask)) / 2;
        o = h = l = c = mid;
      }
    } else {
      // date[,time],O,H,L,C[,V] — MT4 exports and most generic CSVs
      const looksLikeDateFirst = /^\d{4}[.\-/]/.test((cols[0] ?? "").trim());
      if (!looksLikeDateFirst) {
        skipped++;
        // every corrupt line lands here, so it MUST say so — this branch used to count the
        // row as skipped while reporting no error at all
        if (errors.length < 5) errors.push(`no date: ${line.slice(0, 70)}`);
        continue;
      }
      const hasTimeCol = /^\d{1,2}:\d{2}/.test((cols[1] ?? "").trim());
      if (hasTimeCol) {
        time = parseLoose(cols[0]!, cols[1]!);
        o = Number(cols[2]);
        h = Number(cols[3]);
        l = Number(cols[4]);
        c = Number(cols[5]);
        v = cols[6] !== undefined ? Number(cols[6]) : 0;
      } else {
        time = parseLoose(cols[0]!, "00:00:00");
        o = Number(cols[1]);
        h = Number(cols[2]);
        l = Number(cols[3]);
        c = Number(cols[4]);
        v = cols[5] !== undefined ? Number(cols[5]) : 0;
      }
      // an ISO timestamp in the first column, with no separate time column
      if (time === null && cols.length >= 5) {
        const iso = parseIso(cols[0]!);
        if (iso !== null) {
          time = iso;
          o = Number(cols[1]);
          h = Number(cols[2]);
          l = Number(cols[3]);
          c = Number(cols[4]);
        }
      }
    }

    if (time === null || !Number.isFinite(o) || !Number.isFinite(h) ||
        !Number.isFinite(l) || !Number.isFinite(c)) {
      skipped++;
      // say WHICH part failed: a valid date with a non-numeric price is a different bug from
      // an unreadable date, and both used to report the same thing
      if (errors.length < 5) {
        const why = time === null ? "no date" : "non-numeric OHLC";
        errors.push(`${why}: ${line.slice(0, 70)}`);
      }
      continue;
    }

    // OHLC sanity: a bar whose high is below its low is corrupt, not a data point
    if (h < l) {
      skipped++;
      if (errors.length < 5) errors.push(`high < low: ${line.slice(0, 60)}`);
      continue;
    }

    candles.push({
      time: time - utcOffsetHours * 3600,
      open: o, high: h, low: l, close: c,
      volume: Number.isFinite(v) ? v : 0,
    });
  }

  candles.sort((a, b) => a.time - b.time);

  return {
    candles,
    skipped,
    format: det.format,
    firstTime: candles.length > 0 ? candles[0]!.time : null,
    lastTime: candles.length > 0 ? candles[candles.length - 1]!.time : null,
    errors,
  };
}

/**
 * Parse a decompressed Dukascopy day file.
 *
 * Needs the day it belongs to, because the file stores offsets from midnight rather than
 * absolute times.
 */
export function parseDukascopyDay(
  raw: Uint8Array,
  symbol: string,
  year: number,
  month1: number,
  day: number,
): ParseResult {
  const bars: DukaBar[] = decodeCandles(raw, pointScale(symbol));
  const midnight = Date.UTC(year, month1 - 1, day) / 1000;
  const candles = bars.map((b) => ({
    time: midnight + b.offset,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));

  return {
    candles,
    skipped: 0,
    format: "dukascopy-bi5",
    firstTime: candles.length > 0 ? candles[0]!.time : null,
    lastTime: candles.length > 0 ? candles[candles.length - 1]!.time : null,
    errors: [],
  };
}

/**
 * Merge several parsed files into one series.
 *
 * Overlapping files are common when someone downloads by month and by year. Later entries win
 * for the same timestamp — not because they are newer, but because the last file the user
 * added is the one they expect to see.
 */
export function mergeResults(results: readonly ParseResult[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const r of results) {
    for (const c of r.candles) byTime.set(c.time, c);
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

/**
 * A quality report.
 *
 * A file that parses is not a file that is usable: gaps, duplicate timestamps and zero prices
 * all produce a chart that looks fine and a backtest that is wrong.
 */
export interface QualityReport {
  bars: number;
  firstTime: number | null;
  lastTime: number | null;
  /** most common spacing in seconds, which is the inferred timeframe */
  spacingSeconds: number | null;
  /** gaps larger than 2x the spacing */
  gaps: number;
  largestGapSeconds: number;
  /** bars with a zero or negative price */
  badPrices: number;
  /** duplicate timestamps across merged files */
  duplicates: number;
  /** weekend bars, which some sources include and some do not */
  weekendBars: number;
  verdict: "clean" | "usable" | "suspect";
  notes: string[];
}

export function auditCandles(candles: readonly Candle[]): QualityReport {
  const notes: string[] = [];
  if (candles.length === 0) {
    return {
      bars: 0, firstTime: null, lastTime: null, spacingSeconds: null,
      gaps: 0, largestGapSeconds: 0, badPrices: 0, duplicates: 0,
      weekendBars: 0, verdict: "suspect", notes: ["no bars"],
    };
  }

  // spacing from the differences that occur
  const counts = new Map<number, number>();
  let duplicates = 0;
  let badPrices = 0;
  let weekendBars = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (!(c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0)) badPrices++;
    const dow = new Date(c.time * 1000).getUTCDay();
    if (dow === 0 || dow === 6) weekendBars++;
    if (i > 0) {
      const d = c.time - candles[i - 1]!.time;
      if (d === 0) duplicates++;
      else if (d > 0) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }

  let spacing: number | null = null;
  let best = 0;
  // Array.from, not for..of: the target is es5, where a Map is not iterable
  for (const [d, n] of Array.from(counts.entries())) {
    if (n > best) { best = n; spacing = d; }
  }

  let gaps = 0;
  let largest = 0;
  if (spacing !== null) {
    for (const d of Array.from(counts.keys())) {
      if (d > spacing * 2) {
        gaps += counts.get(d)!;
        if (d > largest) largest = d;
      }
    }
  }

  if (badPrices > 0) notes.push(`${badPrices} bars with a non-positive price`);
  if (duplicates > 0) notes.push(`${duplicates} duplicate timestamps`);
  if (gaps > 0) notes.push(`${gaps} gaps, largest ${Math.round(largest / 3600)}h`);
  if (spacing !== null && weekendBars === 0) {
    notes.push("no weekend bars — the source filters them, so session calculations differ");
  }

  const verdict: QualityReport["verdict"] =
    badPrices > 0 ? "suspect"
      : gaps > candles.length * 0.05 ? "usable"
        : "clean";

  return {
    bars: candles.length,
    firstTime: candles[0]!.time,
    lastTime: candles[candles.length - 1]!.time,
    spacingSeconds: spacing,
    gaps,
    largestGapSeconds: largest,
    badPrices,
    duplicates,
    weekendBars,
    verdict,
    notes,
  };
}

/** Human summary of a spacing in seconds. */
export function describeSpacing(seconds: number | null): string {
  if (seconds === null) return "unknown";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}
