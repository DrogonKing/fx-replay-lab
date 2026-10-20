/**
 * CSV import.
 *
 * The spec requires automatic delimiter detection, header skipping, and two
 * column layouts:
 *   A. date,time,O,H,L,C[,volume]   (MT4/MT5 export; dates 2024.01.02 or
 *                                   2024-01-02, times 10:00 or 10:00:00)
 *   B. timestamp,O,H,L,C           (epoch s, epoch ms, or ISO date-time)
 *
 * Plus a "CSV time offset (hours from UTC)" setting that shifts imported times,
 * because exports from brokers are usually in broker-server time (often EET/
 * EEST) rather than UTC. Getting this wrong shifts the entire session structure,
 * so it is an explicit, tested input rather than a guess.
 */
import type { Candle } from "./types.js";

export type CsvLayout = "datetime-split" | "timestamp";

export interface CsvImportOptions {
  /** override delimiter; "auto" detects comma/semicolon/tab */
  delimiter?: "," | ";" | "\t" | "auto";
  /** hours to ADD to parsed times to reach UTC (e.g. +2 for EET) */
  utcOffsetHours?: number;
  /** force a layout instead of detecting it */
  layout?: CsvLayout | "auto";
  /** true when the first non-empty line is a header */
  hasHeader?: boolean | "auto";
}

export interface CsvImportResult {
  candles: Candle[];
  delimiter: string;
  layout: CsvLayout;
  skippedHeader: boolean;
  rowsRead: number;
  rowsRejected: number;
  rejectedExamples: string[];
  /** median bar spacing in minutes, for the base-timeframe readout */
  detectedMinutes: number;
}

const NUM = /^[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?$/;

export function detectDelimiter(line: string): "," | ";" | "\t" {
  const counts = {
    ",": (line.match(/,/g) ?? []).length,
    ";": (line.match(/;/g) ?? []).length,
    "\t": (line.match(/\t/g) ?? []).length,
  };
  const best = (Object.entries(counts) as Array<["," | ";" | "\t", number]>)
    .sort((a, b) => b[1] - a[1])[0]!;
  return best[1] > 0 ? best[0] : ",";
}

function isNumericField(s: string): boolean {
  return NUM.test(s.trim());
}

/**
 * Detect the layout from the first data row.
 * A timestamp layout has a numeric or ISO first field and exactly 5+ columns
 * without a separate time column.
 */
export function detectLayout(cols: string[]): CsvLayout {
  if (cols.length >= 6 && !isNumericField(cols[0]!)) {
    // date,time,O,H,L,C -> second column is a time
    if (/^\d{1,2}:\d{2}/.test(cols[1]!.trim())) return "datetime-split";
  }
  if (isNumericField(cols[0]!)) return "timestamp";
  // ISO datetime in the first column also means "timestamp"
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(cols[0]!.trim())) return "timestamp";
  return "datetime-split";
}

/**
 * Parse a date+time pair into UTC epoch seconds.
 * Accepts 2024.01.02 / 2024-01-02 / 2024/01/02 and 10:00 / 10:00:00.
 */
export function parseDateTimeParts(
  dateStr: string,
  timeStr: string,
  utcOffsetHours: number,
): number | null {
  const dm = /^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})$/.exec(dateStr.trim());
  if (!dm) return null;
  const y = Number(dm[1]);
  const mo = Number(dm[2]);
  const d = Number(dm[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;

  let h = 0, mi = 0, sec = 0;
  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(timeStr.trim());
  if (tm) {
    h = Number(tm[1]);
    mi = Number(tm[2]);
    sec = tm[3] ? Number(tm[3]) : 0;
  } else if (timeStr.trim() !== "") {
    return null;
  }
  if (h > 23 || mi > 59 || sec > 59) return null;

  const asUtc = Date.UTC(y, mo - 1, d, h, mi, sec) / 1000;
  // Shift from source zone to UTC: if the source is UTC+2, subtract 2h.
  return asUtc - utcOffsetHours * 3600;
}

/**
 * Parse a single timestamp field: epoch seconds, epoch milliseconds, or ISO.
 * Epoch milliseconds are distinguished by magnitude: anything above 1e11 cannot
 * be seconds before the year 5138, so it is treated as milliseconds.
 */
export function parseTimestampField(raw: string, utcOffsetHours: number): number | null {
  const s = raw.trim();
  if (s === "") return null;

  if (isNumericField(s)) {
    const v = Number(s);
    if (!Number.isFinite(v)) return null;
    const abs = Math.abs(v);
    if (abs >= 1e11) return Math.floor(v / 1000) - utcOffsetHours * 3600; // ms
    if (abs >= 1e8) return Math.floor(v) - utcOffsetHours * 3600;        // seconds
    return null;                                                          // implausible
  }

  // ISO 8601: 2024-01-02T10:00:00Z / 2024-01-02 10:00:00 / with offset
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/
    .exec(s);
  if (iso) {
    const [, y, mo, d, h, mi, sec, tz] = iso;
    if (tz) {
      // An explicit zone makes the value absolute: do not apply the CSV offset.
      const ms = Date.parse(s.replace(" ", "T"));
      return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
    }
    const base = Date.UTC(
      Number(y), Number(mo) - 1, Number(d),
      Number(h), Number(mi), Number(sec ?? 0),
    ) / 1000;
    return base - utcOffsetHours * 3600;
  }

  // Dotted or slashed date with a time in the SAME field: 2024.01.02 10:00 / 2024/01/02 10:00:00
  //
  // MT4/MT5 exports and most broker CSVs use this, and it used to fail here while
  // parseDateTimeParts accepted it — so a file whose date and clock share one column was
  // read by neither parser and every row was rejected as a bad timestamp.
  const dotted = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (dotted) {
    const [, y, mo, d, h, mi, sec] = dotted;
    const base = Date.UTC(
      Number(y), Number(mo) - 1, Number(d),
      Number(h), Number(mi), Number(sec ?? 0),
    ) / 1000;
    return Number.isFinite(base) ? base - utcOffsetHours * 3600 : null;
  }

  // A bare date, no clock: midnight.
  const dateOnly = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/.exec(s);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    const base = Date.UTC(Number(y), Number(mo) - 1, Number(d)) / 1000;
    return Number.isFinite(base) ? base - utcOffsetHours * 3600 : null;
  }

  return null;
}

/** Median spacing in minutes across the parsed bars, ignoring weekend gaps. */
export function medianSpacingMinutes(candles: readonly Candle[], sample = 500): number {
  const n = Math.min(candles.length - 1, sample);
  if (n <= 0) return 0;
  const diffs: number[] = [];
  for (let i = 1; i <= n; i++) {
    const d = candles[i]!.time - candles[i - 1]!.time;
    if (d > 0 && d <= 4 * 3600) diffs.push(d);
  }
  if (diffs.length === 0) return 0;
  diffs.sort((a, b) => a - b);
  const mid = Math.floor(diffs.length / 2);
  return (diffs.length % 2 === 1 ? diffs[mid]! : (diffs[mid - 1]! + diffs[mid]!) / 2) / 60;
}

/**
 * Parse a whole CSV document.
 *
 * Rules that matter for real broker exports:
 *  - blank lines and BOM are ignored;
 *  - a row whose OHLC is not all numeric is skipped and counted, never silently
 *    coerced to 0 (that would invent a fake crash in the chart);
 *  - rows with high < low or high < max(open,close) are rejected as invalid;
 *  - output is sorted by time, because some exports are newest-first.
 */
export function parseCsv(text: string, opts: CsvImportOptions = {}): CsvImportResult {
  const utcOffsetHours = opts.utcOffsetHours ?? 0;
  const cleaned = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const rawLines = cleaned.split("\n").filter((l) => l.trim() !== "");
  if (rawLines.length === 0) {
    throw new Error("CSV is empty");
  }

  const delimiter = opts.delimiter && opts.delimiter !== "auto"
    ? opts.delimiter
    : detectDelimiter(rawLines[0]!);

  const firstCols = splitLine(rawLines[0]!, delimiter);
  const layout = opts.layout && opts.layout !== "auto"
    ? opts.layout
    : detectLayout(firstCols);

  // Header detection.
  //
  // Only the OHLC slots are decisive. Testing "any non-numeric column" is wrong:
  // in a datetime-split export column 1 is the time ("10:00"), which is not
  // numeric, so a headerless file would be misdetected as having a header and
  // its first bar silently eaten.
  let skipHeader: boolean;
  if (typeof opts.hasHeader === "boolean") {
    skipHeader = opts.hasHeader;
  } else if (layout === "datetime-split") {
    // OHLC live at indices 2..5
    skipHeader = firstCols.slice(2, 6).some((c) => !isNumericField(c));
  } else {
    // timestamp layout: OHLC at indices 1..4
    skipHeader = firstCols.slice(1, 5).some((c) => !isNumericField(c));
  }

  const candles: Candle[] = [];
  const rejected: string[] = [];
  let rowsRead = 0;

  for (let li = skipHeader ? 1 : 0; li < rawLines.length; li++) {
    const line = rawLines[li]!;
    const cols = splitLine(line, delimiter);
    rowsRead++;

    let time: number | null = null;
    let oIdx: number, hIdx: number, lIdx: number, cIdx: number, vIdx: number;

    if (layout === "datetime-split") {
      if (cols.length < 6) { rejected.push(line); continue; }
      time = parseDateTimeParts(cols[0]!, cols[1]!, utcOffsetHours);
      oIdx = 2; hIdx = 3; lIdx = 4; cIdx = 5; vIdx = 6;
    } else {
      if (cols.length < 5) { rejected.push(line); continue; }
      time = parseTimestampField(cols[0]!, utcOffsetHours);
      oIdx = 1; hIdx = 2; lIdx = 3; cIdx = 4; vIdx = 5;
    }

    if (time == null) { rejected.push(line); continue; }

    const o = Number(cols[oIdx]);
    const h = Number(cols[hIdx]);
    const l = Number(cols[lIdx]);
    const c = Number(cols[cIdx]);
    if (![o, h, l, c].every((v) => Number.isFinite(v))) { rejected.push(line); continue; }

    const volRaw = cols[vIdx];
    let v = 0;
    if (volRaw != null && isNumericField(volRaw)) {
      const parsed = Number(volRaw);
      // Some exports put a float in volume; keep it, the chart can cope.
      v = Number.isFinite(parsed) ? parsed : 0;
    }

    // Validity: a bar whose high is below its low or below open/close is corrupt.
    if (h < l || h < o || h < c || l > o || l > c) {
      rejected.push(line);
      continue;
    }

    candles.push({ time, open: o, high: h, low: l, close: c, volume: v });
  }

  candles.sort((a, b) => a.time - b.time);

  return {
    candles,
    delimiter,
    layout,
    skippedHeader: skipHeader,
    rowsRead,
    rowsRejected: rejected.length,
    rejectedExamples: rejected.slice(0, 5),
    detectedMinutes: medianSpacingMinutes(candles),
  };
}

/** Split a line, tolerating trailing spaces around fields. */
function splitLine(line: string, delimiter: string): string[] {
  return line.split(delimiter).map((f) => f.trim());
}
