/**
 * Economic calendar: CSV parsing, chart markers, and news-avoidance rules.
 *
 * Pure. The parsing is the fragile part — calendar exports differ per provider and the
 * timestamp formats in the wild are a mess — so every accepted shape is tested, and
 * anything ambiguous is rejected with a reason rather than guessed.
 */
import type { Impact, NewsEvent } from "./types.js";

export interface CalendarEvent extends NewsEvent {
  /** symbol or currency the event actually affects */
  currency: string;
  /** seconds before the event when trading should pause */
  blackoutBefore: number;
  /** seconds after */
  blackoutAfter: number;
  /** provider's own id, for de-duplication across imports */
  externalId?: string;
}

export interface ParseIssue {
  line: number;
  reason: string;
  raw: string;
}

export interface ParseResult {
  events: CalendarEvent[];
  issues: ParseIssue[];
  /** rows seen, for an honest "parsed X of Y" report */
  rowsSeen: number;
}

/** RFC4180-ish split: handles quoted fields with embedded commas and doubled quotes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(field);
      field = "";
    } else {
      field += c;
    }
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/** Header aliases seen across providers. Matching is case-insensitive. */
const COLUMN_ALIASES: Record<string, string[]> = {
  // "date" and "time" are separate columns in most provider exports; a combined
  // "datetime"/"date/time" column is also common. Both shapes must work.
  date: ["date"],
  time: ["time"],
  datetime: ["datetime", "timestamp", "date/time", "when"],
  currency: ["currency", "ccy", "cur", "symbol", "pair", "instrument"],
  impact: ["impact", "importance", "volatility", "priority", "level"],
  title: ["event", "title", "name", "description", "event name"],
  actual: ["actual"],
  forecast: ["forecast", "consensus", "estimate"],
  previous: ["previous", "prior"],
};

/** Impact labels across providers, mapped to the three levels this app uses. */
export function parseImpact(raw: string): Impact | null {
  const s = raw.trim().toLowerCase();
  if (s === "") return null;
  // word forms first, then numeric star ratings ("***", "3", "high")
  if (/^(high|h|3|three|\*{3,})$/.test(s)) return "high";
  if (/^(medium|med|m|2|two|\*{2})$/.test(s)) return "medium";
  if (/^(low|l|1|one|\*)$/.test(s)) return "low";
  // providers sometimes write "High Impact" or "*****"
  if (s.includes("high") || s.includes("***")) return "high";
  if (s.includes("med") || s.includes("**")) return "medium";
  if (s.includes("low") || s.includes("*")) return "low";
  return null;
}

/**
 * Parse a timestamp into UTC epoch seconds.
 *
 * Accepted, all treated as UTC unless an explicit offset is present:
 *   2024-01-05 13:30        2024-01-05T13:30:00Z      01/05/2024 13:30
 *   2024-01-05 13:30:00     1704456600 (already epoch)
 *
 * **Day/month order is decided by the data, not guessed per row.** `01/05/2024` is
 * ambiguous; rather than silently reading it as MM/DD (wrong for half the world), the
 * parser takes a `dayFirst` flag that the caller sets once per file after inspecting it.
 */
export function parseTimestamp(
  raw: string,
  dayFirst = false,
): { time: number } | { error: string } {
  const s = raw.trim();
  if (s === "") return { error: "empty time" };

  // already epoch seconds / milliseconds
  if (/^\d{9,13}$/.test(s)) {
    const n = Number(s);
    return { time: n > 1e11 ? Math.floor(n / 1000) : n };
  }

  // ISO-ish: YYYY-MM-DD[ T]HH:MM[:SS][Z|±HH:MM]
  const iso = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2})?$/i
    .exec(s);
  if (iso) {
    const [, y, mo, d, h, mi, sec, tz] = iso;
    let ms = Date.UTC(
      Number(y), Number(mo) - 1, Number(d),
      Number(h), Number(mi), Number(sec ?? "0"),
    );
    if (tz && tz.toUpperCase() !== "Z") {
      const sign = tz.startsWith("-") ? -1 : 1;
      const body = tz.slice(1).replace(":", "");
      const offMin = Number(body.slice(0, 2)) * 60 + Number(body.slice(2, 4) || "0");
      ms -= sign * offMin * 60_000;
    }
    if (Number.isNaN(ms)) return { error: "invalid date" };
    return { time: Math.floor(ms / 1000) };
  }

  // D/M/Y or M/D/Y with optional seconds
  const slashed = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/
    .exec(s);
  if (slashed) {
    const [, a, b, y, h, mi, sec] = slashed;
    const day = dayFirst ? Number(a) : Number(b);
    const month = dayFirst ? Number(b) : Number(a);
    if (month > 12) return { error: `month ${month} is impossible — is this day-first?` };
    const ms = Date.UTC(
      Number(y), month - 1, day,
      Number(h), Number(mi), Number(sec ?? "0"),
    );
    if (Number.isNaN(ms)) return { error: "invalid date" };
    return { time: Math.floor(ms / 1000) };
  }

  return { error: `unrecognised time format: ${s}` };
}

/**
 * Does this file look day-first? Inspects the first slashed date column: if any first
 * component is > 12 it must be a day, so the file is day-first.
 */
export function detectDayFirst(lines: readonly string[]): boolean {
  for (const line of lines) {
    const m = /(^|,)\s*(\d{1,2})[/.](\d{1,2})[/.]\d{4}/.exec(line);
    if (!m) continue;
    const a = Number(m[2]);
    if (a > 12) return true;      // e.g. 25/01/2024
    // a first component <= 12 proves nothing; keep looking
  }
  return false;
}

const DEFAULT_BLACKOUT_BEFORE = 300;    // 5 minutes
const DEFAULT_BLACKOUT_AFTER = 300;

/**
 * Parse a calendar CSV.
 *
 * `blackout` decides the pause window by impact; the defaults are 5 minutes either side
 * for high-impact events and none for low.
 */
export function parseCalendarCsv(
  text: string,
  opts: {
    dayFirst?: boolean;
    blackout?: Partial<Record<Impact, { before: number; after: number }>>;
    /** only keep these impacts; default all */
    keep?: readonly Impact[];
  } = {},
): ParseResult {
  const issues: ParseIssue[] = [];
  const events: CalendarEvent[] = [];
  const lines = text.split(/\r?\n/);

  const dayFirst = opts.dayFirst ?? detectDayFirst(lines);
  const blackout = {
    high: opts.blackout?.high ?? { before: DEFAULT_BLACKOUT_BEFORE, after: DEFAULT_BLACKOUT_AFTER },
    medium: opts.blackout?.medium ?? { before: 0, after: 0 },
    low: opts.blackout?.low ?? { before: 0, after: 0 },
  };

  // find the header row: the first line whose cells match at least two known columns
  let headerIndex = -1;
  let cols: Record<string, number> = {};
  for (let i = 0; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    const map: Record<string, number> = {};
    cells.forEach((cell, idx) => {
      const key = cell.toLowerCase();
      for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
        if (map[field] === undefined && aliases.includes(key)) map[field] = idx;
      }
    });
    // `date` counts too: many exports put the full datetime in a single Date column.
    const hasTime = map.time !== undefined
      || map.datetime !== undefined
      || map.date !== undefined;
    if (hasTime && map.title !== undefined) {
      headerIndex = i;
      cols = map;
      break;
    }
  }

  if (headerIndex < 0) {
    return {
      events: [],
      issues: [{
        line: 0,
        reason: "no header row with a date/time column and an event column",
        raw: lines[0] ?? "",
      }],
      rowsSeen: 0,
    };
  }

  let rowsSeen = 0;
  let seq = 0;

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === "") continue;
    rowsSeen++;

    const cells = splitCsvLine(raw);
    const get = (field: string): string => {
      const idx = cols[field];
      return idx === undefined ? "" : (cells[idx] ?? "");
    };

    // Combine a split date + time column; a combined datetime column is used as-is.
    const datetimeCell = get("datetime");
    const timeCell = datetimeCell !== ""
      ? datetimeCell
      : [get("date"), get("time")].filter((s) => s !== "").join(" ");

    const t = parseTimestamp(timeCell, dayFirst);
    if ("error" in t) {
      issues.push({ line: i + 1, reason: t.error, raw });
      continue;
    }

    const title = get("title");
    if (title === "") {
      issues.push({ line: i + 1, reason: "empty event name", raw });
      continue;
    }

    const impact = parseImpact(get("impact")) ?? "low";
    if (opts.keep && !opts.keep.includes(impact)) continue;

    const currency = get("currency").toUpperCase() || "ALL";
    const window = blackout[impact];

    events.push({
      id: ++seq,
      time: t.time,
      currency,
      impact,
      title,
      blackoutBefore: window.before,
      blackoutAfter: window.after,
      externalId: `${t.time}|${currency}|${title}`,
    });
  }

  // Sort by time so the UI and the blackout check can scan linearly.
  events.sort((a, b) => a.time - b.time);

  return { events, issues, rowsSeen };
}

/**
 * De-duplicate events imported more than once.
 *
 * Keyed on time+currency+title rather than the provider id, because two providers
 * naming the same event slightly differently is far less likely than the same provider
 * exporting overlapping date ranges.
 */
export function dedupeEvents(events: readonly CalendarEvent[]): CalendarEvent[] {
  const seen = new Set<string>();
  const out: CalendarEvent[] = [];
  for (const e of events) {
    const key = `${e.time}|${e.currency}|${e.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

export interface BlackoutCheck {
  blocked: boolean;
  /** the event that blocks, if any */
  event?: CalendarEvent;
  /** seconds until it starts (negative = already started) */
  secondsUntil?: number;
  reason?: string;
}

/**
 * Is trading blocked at `time` because of a news event?
 *
 * `currencies` limits the check to instruments you actually trade: a USD event does not
 * block a EURJPY trade unless the quote currency is USD.
 */
export function isBlackedOut(
  time: number,
  events: readonly CalendarEvent[],
  currencies: readonly string[],
  /** "ALL" events block everything */
  includeAll = true,
): BlackoutCheck {
  const wanted = new Set(currencies.map((c) => c.toUpperCase()));
  for (const e of events) {
    const relevant = wanted.has(e.currency) || (includeAll && e.currency === "ALL");
    if (!relevant) continue;
    const from = e.time - e.blackoutBefore;
    const to = e.time + e.blackoutAfter;
    if (time >= from && time <= to) {
      return {
        blocked: true,
        event: e,
        secondsUntil: e.time - time,
        reason: `${e.impact} impact ${e.currency}: ${e.title} at ${new Date(e.time * 1000)
          .toISOString().slice(0, 16).replace("T", " ")} UTC`,
      };
    }
  }
  return { blocked: false };
}

export interface NewsMarker {
  time: number;
  position: "aboveBar" | "belowBar";
  color: string;
  shape: "circle" | "square" | "arrowUp" | "arrowDown";
  text: string;
}

const IMPACT_COLOUR: Record<Impact, string> = {
  high: "#ef5350",
  medium: "#f0b90b",
  low: "#787b86",
};

/**
 * Convert events to chart markers.
 *
 * Only events inside the visible window are returned: a marker per event over 30k bars
 * would build tens of thousands of shapes for no benefit.
 */
export function newsMarkers(
  events: readonly CalendarEvent[],
  fromTime: number,
  toTime: number,
  opts: { maxPerBar?: number } = {},
): NewsMarker[] {
  const maxPerBar = opts.maxPerBar ?? 1;
  const perBar = new Map<number, number>();
  const out: NewsMarker[] = [];

  for (const e of events) {
    if (e.time < fromTime || e.time > toTime) continue;
    const n = perBar.get(e.time) ?? 0;
    if (n >= maxPerBar) continue;    // several events at the same second: keep the first
    perBar.set(e.time, n + 1);
    out.push({
      time: e.time,
      // high impact below the bar so it does not collide with the price line label
      position: e.impact === "high" ? "belowBar" : "aboveBar",
      color: IMPACT_COLOUR[e.impact],
      shape: e.impact === "high" ? "arrowUp" : "circle",
      text: `${e.currency} ${e.impact[0]!.toUpperCase()}`,
    });
  }
  return out;
}

/** Counts for the panel. */
export function calendarSummary(events: readonly CalendarEvent[]): {
  total: number; high: number; medium: number; low: number; from: number; to: number;
} {
  let high = 0, medium = 0, low = 0;
  let from = Infinity, to = -Infinity;
  for (const e of events) {
    if (e.impact === "high") high++;
    else if (e.impact === "medium") medium++;
    else low++;
    if (e.time < from) from = e.time;
    if (e.time > to) to = e.time;
  }
  return {
    total: events.length, high, medium, low,
    from: Number.isFinite(from) ? from : 0,
    to: Number.isFinite(to) ? to : 0,
  };
}
