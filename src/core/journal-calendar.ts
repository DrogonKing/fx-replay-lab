/**
 * The journal's R-multiple calendar, and a printable report.
 *
 * The journal reported win rate and average R. Neither shows the thing a trader actually needs
 * to see: WHICH DAYS the damage happened on, and whether the losses cluster. A calendar of
 * daily net R makes a revenge-trading spiral or a bad-news-day habit visible at a glance, and
 * neither a win rate nor an equity curve shows it.
 *
 * Pure. The layout maths is the part that is easy to get subtly wrong (week boundaries, month
 * edges), so it is tested without a DOM.
 */

/**
 * A closed trade as the journal records it.
 *
 * Defined here, in core, rather than in the panel: core cannot import from the renderer, and
 * a type-only import still breaks the `--jsx` boundary. The panel imports THIS.
 */
export interface JournalEntry {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  lots: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  /** initial risk in money, used for the R multiple */
  risk: number;
  tags: string[];
  notes: string;
}

export interface CalendarDay {
  /** UTC date, "YYYY-MM-DD" */
  date: string;
  /** day of month, 1..31 */
  day: number;
  /** sum of R multiples for the day; NaN when there were no trades */
  r: number;
  trades: number;
  wins: number;
  losses: number;
  /** gross profit and loss, for the tooltip */
  pnl: number;
}

export interface CalendarMonth {
  /** "YYYY-MM" */
  month: string;
  year: number;
  /** 0..11 */
  monthIndex: number;
  /** weeks, each 7 slots Monday..Sunday; null where the day is outside the month */
  weeks: Array<Array<CalendarDay | null>>;
  totalR: number;
  trades: number;
  tradingDays: number;
}

/** R multiple for one entry. Zero risk means the R is undefined, not infinite. */
export function rMultiple(entry: JournalEntry): number {
  if (!(entry.risk > 0)) return 0;
  return entry.pnl / entry.risk;
}

/** "YYYY-MM-DD" in UTC. */
export function dayKey(epoch: number): string {
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}

/**
 * Group entries by their EXIT day.
 *
 * The exit is the right day: a trade carried over a weekend belongs to the day it was closed,
 * because that is when the money moved and when the decision was validated.
 */
export function dailyR(entries: readonly JournalEntry[]): Map<string, CalendarDay> {
  const out = new Map<string, CalendarDay>();

  for (const e of entries) {
    const key = dayKey(e.exitTime);
    const r = rMultiple(e);
    const cur = out.get(key) ?? {
      date: key,
      day: Number(key.slice(8, 10)),
      r: 0,
      trades: 0,
      wins: 0,
      losses: 0,
      pnl: 0,
    };
    cur.r += r;
    cur.pnl += e.pnl;
    cur.trades++;
    if (e.pnl > 0) cur.wins++;
    else if (e.pnl < 0) cur.losses++;
    out.set(key, cur);
  }

  return out;
}

/** Monday = 0, Sunday = 6. JS gives Sunday = 0, which shifts every calendar by a day. */
export function mondayIndex(epoch: number): number {
  const js = new Date(epoch * 1000).getUTCDay();
  return (js + 6) % 7;
}

/**
 * Build one month's grid.
 *
 * Weeks run Monday..Sunday, matching how a trading week is actually read. Slots before the 1st
 * and after the last day are null, not zero: a zero-R day and a day that does not exist must
 * not look the same.
 */
export function buildMonth(
  entries: readonly JournalEntry[],
  year: number,
  monthIndex: number,
): CalendarMonth {
  const byDay = dailyR(entries);

  const first = Date.UTC(year, monthIndex, 1) / 1000;
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const lead = mondayIndex(first);

  const weeks: Array<Array<CalendarDay | null>> = [];
  let week: Array<CalendarDay | null> = new Array(7).fill(null);
  for (let i = 0; i < lead; i++) week[i] = null;

  for (let d = 1; d <= daysInMonth; d++) {
    const epoch = Date.UTC(year, monthIndex, d) / 1000;
    const key = dayKey(epoch);
    const slot = mondayIndex(epoch);
    week[slot] = byDay.get(key) ?? {
      date: key, day: d, r: 0, trades: 0, wins: 0, losses: 0, pnl: 0,
    };
    if (slot === 6) {
      weeks.push(week);
      week = new Array(7).fill(null);
    }
  }
  // a trailing partial week is still a week
  if (week.some((s) => s !== null)) weeks.push(week);

  let totalR = 0;
  let trades = 0;
  let tradingDays = 0;
  for (const w of weeks) {
    for (const d of w) {
      if (!d) continue;
      totalR += d.r;
      trades += d.trades;
      if (d.trades > 0) tradingDays++;
    }
  }

  return {
    month: `${year}-${String(monthIndex + 1).padStart(2, "0")}`,
    year,
    monthIndex,
    weeks,
    totalR,
    trades,
    tradingDays,
  };
}

/** Every month that has at least one entry, oldest first. */
export function monthsWithTrades(entries: readonly JournalEntry[]): Array<{ year: number; monthIndex: number }> {
  const seen = new Set<string>();
  const out: Array<{ year: number; monthIndex: number }> = [];
  for (const e of entries) {
    const d = new Date(e.exitTime * 1000);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ year: d.getUTCFullYear(), monthIndex: d.getUTCMonth() });
  }
  out.sort((a, b) => a.year - b.year || a.monthIndex - b.monthIndex);
  return out;
}

/**
 * Colour bucket for a day's R.
 *
 * Bucketed rather than continuous: a trader reads "big loss / loss / flat / win / big win"
 * faster than a gradient, and the buckets do not change meaning between months the way an
 * auto-scaled gradient does.
 */
export type RBucket = "none" | "bigLoss" | "loss" | "flat" | "win" | "bigWin";

export function bucketFor(r: number, trades: number): RBucket {
  if (trades === 0) return "none";
  if (r <= -2) return "bigLoss";
  if (r < -0.15) return "loss";
  if (r <= 0.15) return "flat";
  if (r < 2) return "win";
  return "bigWin";
}

export const BUCKET_COLOUR: Record<RBucket, string> = {
  none: "#1a1d26",
  bigLoss: "#8b2b2b",
  loss: "#5c2b2b",
  flat: "#2f333d",
  win: "#2b5c3a",
  bigWin: "#2f7d4a",
};

export interface JournalSummary {
  months: number;
  days: number;
  totalR: number;
  /** the single worst day, for the "your worst day" line */
  worstDay: CalendarDay | null;
  bestDay: CalendarDay | null;
  /** consecutive losing days, longest run */
  longestLosingStreak: number;
  /** days where the loss exceeded 2R */
  blowupDays: number;
}

/** Headline numbers, including the ones that are uncomfortable. */
export function summarise(entries: readonly JournalEntry[]): JournalSummary {
  const byDay = dailyR(entries);
  const days = Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date));
  const withTrades = days.filter((d) => d.trades > 0);

  let worst: CalendarDay | null = null;
  let best: CalendarDay | null = null;
  for (const d of withTrades) {
    if (!worst || d.r < worst.r) worst = d;
    if (!best || d.r > best.r) best = d;
  }

  let streak = 0;
  let longest = 0;
  for (const d of withTrades) {
    if (d.r < 0) {
      streak++;
      if (streak > longest) longest = streak;
    } else {
      streak = 0;
    }
  }

  return {
    months: monthsWithTrades(entries).length,
    days: withTrades.length,
    totalR: withTrades.reduce((a, d) => a + d.r, 0),
    worstDay: worst,
    bestDay: best,
    longestLosingStreak: longest,
    blowupDays: withTrades.filter((d) => d.r <= -2).length,
  };
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const WEEKDAY_INITIALS = ["M", "T", "W", "T", "F", "S", "S"];

export function monthTitle(m: CalendarMonth): string {
  return `${MONTH_NAMES[m.monthIndex]} ${m.year}`;
}

export function weekdayLabels(): string[] {
  return [...WEEKDAY_INITIALS];
}

/** One line per month, for the printable report. */
export function monthLines(m: CalendarMonth): string[] {
  return [
    `${monthTitle(m)}: ${m.totalR >= 0 ? "+" : ""}${m.totalR.toFixed(2)}R`,
    `${m.trades} trades on ${m.tradingDays} days`,
  ];
}

/**
 * A plain-text report.
 *
 * Deliberately text: a PDF that a user cannot grep, copy into a message, or diff against last
 * month is less useful than the same content in a file. The renderer turns this into a PDF
 * only if asked.
 */
export function textReport(entries: readonly JournalEntry[]): string {
  const s = summarise(entries);
  const lines: string[] = [];
  lines.push("JOURNAL REPORT");
  lines.push("=".repeat(40));
  lines.push(`trades:            ${entries.length}`);
  lines.push(`trading days:      ${s.days}`);
  lines.push(`total R:           ${s.totalR >= 0 ? "+" : ""}${s.totalR.toFixed(2)}R`);
  if (s.worstDay) {
    lines.push(`worst day:         ${s.worstDay.date}  ${s.worstDay.r.toFixed(2)}R (${s.worstDay.trades} trades)`);
  }
  if (s.bestDay) {
    lines.push(`best day:          ${s.bestDay.date}  +${s.bestDay.r.toFixed(2)}R (${s.bestDay.trades} trades)`);
  }
  lines.push(`longest losing run:${String(s.longestLosingStreak).padStart(3)} days`);
  lines.push(`days worse than -2R: ${s.blowupDays}`);
  lines.push("");

  const months = monthsWithTrades(entries);
  for (const m of months) {
    const cal = buildMonth(entries, m.year, m.monthIndex);
    lines.push(monthTitle(cal));
    lines.push(`${cal.totalR >= 0 ? "+" : ""}${cal.totalR.toFixed(2)}R over ${cal.trades} trades`);
    lines.push("Mo Tu We Th Fr Sa Su");
    for (const w of cal.weeks) {
      lines.push(w.map((d) => {
        if (!d) return "  ";
        if (d.trades === 0) return " .";
        const v = Math.round(d.r);
        return String(v).padStart(2, " ");
      }).join(" "));
    }
    lines.push("");
  }

  const byTag = new Map<string, { n: number; r: number }>();
  for (const e of entries) {
    for (const tag of e.tags) {
      const cur = byTag.get(tag) ?? { n: 0, r: 0 };
      cur.n++;
      cur.r += rMultiple(e);
      byTag.set(tag, cur);
    }
  }
  if (byTag.size > 0) {
    lines.push("BY TAG");
    for (const [tag, v] of Array.from(byTag.entries()).sort((a, b) => b[1].r - a[1].r)) {
      lines.push(`  ${tag}: ${v.r >= 0 ? "+" : ""}${v.r.toFixed(2)}R over ${v.n} trades`);
    }
  }

  return lines.join("\n");
}
