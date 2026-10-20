/**
 * Trading sessions: which session a bar belongs to, session bands for the chart, and
 * per-session statistics.
 *
 * Pure. Sessions are defined in each city's LOCAL clock, because that is what "the London
 * session opens at 08:00" means — and London's offset changes with BST while New York's
 * changes on a different date. Treating a session as a fixed UTC window is wrong for about
 * eight months of the year, so the boundaries are converted through the timezone module
 * rather than hardcoded.
 */
import { toWallClock, zoneOffsetSeconds } from "./timezone.js";

export type SessionName = "sydney" | "tokyo" | "london" | "newyork";

export interface SessionDef {
  name: SessionName;
  /** city whose local time defines the session */
  zone: string;
  /** local open hour, 24h */
  openHour: number;
  openMinute: number;
  /** local close hour (may exceed 24 to mean "next day") */
  closeHour: number;
  closeMinute: number;
  colour: string;
}

/**
 * The four sessions, in the order they open through the UTC day.
 *
 * Hours are the conventional FX session hours in each city's own clock:
 *   Sydney  22:00–07:00 local (AEST/AEDT)   — the week opens here
 *   Tokyo   09:00–18:00 local (JST, no DST) — Asia
 *   London  08:00–17:00 local (GMT/BST)     — the biggest volume
 *   New York 08:00–17:00 local (EST/EDT)
 *
 * London and New York overlap 13:00–17:00 London time, which is the most liquid window of
 * the day — the whole reason the overlap is drawn separately.
 */
export const SESSIONS: readonly SessionDef[] = [
  { name: "sydney",  zone: "Australia/Sydney", openHour: 22, openMinute: 0, closeHour: 31, closeMinute: 0, colour: "#4a6fa5" },
  { name: "tokyo",   zone: "Asia/Tokyo",       openHour: 9,  openMinute: 0, closeHour: 18, closeMinute: 0, colour: "#7b5ea7" },
  { name: "london",  zone: "Europe/London",    openHour: 8,  openMinute: 0, closeHour: 17, closeMinute: 0, colour: "#4f9d69" },
  { name: "newyork", zone: "America/New_York", openHour: 8,  openMinute: 0, closeHour: 17, closeMinute: 0, colour: "#c1782c" },
];

export function sessionDef(name: SessionName): SessionDef {
  const d = SESSIONS.find((s) => s.name === name);
  if (!d) throw new Error(`unknown session ${name}`);
  return d;
}

/**
 * UTC epoch seconds of a session's open for the day containing `epochSeconds`.
 *
 * Computed by taking the city's wall clock on that day, replacing the time with the
 * session's local open, and converting back. This is what makes DST correct: the offset
 * used is the one in force on that date, not a fixed number.
 */
export function sessionOpenFor(epochSeconds: number, def: SessionDef): number {
  const wc = toWallClock(epochSeconds, def.zone);
  // A session whose close hour exceeds 24 (Sydney 22:00–07:00) may belong to the previous
  // local day when we are in its after-midnight tail: 03:00 local is still "yesterday's"
  // session. Step back until the local hour is >= the open hour.
  let dayStart = wc.hour < def.openHour ? wc.day - 1 : wc.day;
  // `fromWallClock` handles the DST gaps; a nonexistent 02:00 on a spring-forward day is
  // shifted forward rather than becoming NaN.
  return localToUtc(def.zone, wc.year, wc.month, dayStart, def.openHour, def.openMinute);
}

function localToUtc(
  zone: string, year: number, month: number, day: number, hour: number, minute: number,
): number {
  // Start from UTC and correct by the offset, iterating once: the offset near a DST
  // boundary can differ between the naive guess and the true instant.
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0) / 1000;
  for (let i = 0; i < 3; i++) {
    const off = zoneOffsetSeconds(guess, zone);
    const corrected = Date.UTC(year, month - 1, day, hour, minute, 0) / 1000 - off;
    if (corrected === guess) break;
    guess = corrected;
  }
  return guess;
}

export interface SessionSpan {
  name: SessionName;
  from: number;
  to: number;
  colour: string;
}

/**
 * All session spans overlapping [fromTime, toTime], for drawing bands on the chart.
 *
 * Walks day by day across the range and emits each session's window. Spans that extend
 * past `toTime` are clipped, so the caller can draw them directly.
 */
export function sessionSpans(
  fromTime: number,
  toTime: number,
  opts: { only?: readonly SessionName[] } = {},
): SessionSpan[] {
  if (toTime <= fromTime) return [];
  const only = opts.only ? new Set(opts.only) : null;
  const out: SessionSpan[] = [];

  // Start one day early so a session that opened before the window is still included.
  const dayMs = 86_400;
  const start = Math.floor((fromTime - dayMs) / dayMs) * dayMs;

  for (let t = start; t <= toTime + dayMs; t += dayMs) {
    for (const def of SESSIONS) {
      if (only && !only.has(def.name)) continue;
      const open = sessionOpenFor(t, def);
      const durationHours = def.closeHour + (def.closeMinute / 60)
        - (def.openHour + def.openMinute / 60);
      const close = open + durationHours * 3600;
      if (close <= fromTime || open >= toTime) continue;
      out.push({
        name: def.name,
        from: Math.max(open, fromTime),
        to: Math.min(close, toTime),
        colour: def.colour,
      });
    }
  }

  // Several days produce overlapping duplicates at the seams; sort and drop exact repeats.
  out.sort((a, b) => a.from - b.from || a.name.localeCompare(b.name));
  const seen = new Set<string>();
  return out.filter((s) => {
    const key = `${s.name}|${s.from}|${s.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The session a bar belongs to, for statistics.
 *
 * A bar inside the London/New York overlap is reported as `london` — the overlap is a
 * property of the *pair*, and attributing it to one of them keeps the buckets additive.
 * Use `sessionAtAll()` when you need the overlap as its own label.
 */
export function sessionAt(time: number, only?: readonly SessionName[]): SessionName | null {
  const spans = sessionSpans(time, time + 1, only ? { only } : {});
  // Another window: query the spans that CONTAIN the time.
  const containing = sessionSpans(time - 86_400, time + 86_400, only ? { only } : {})
    .filter((s) => time >= s.from && time < s.to);
  if (containing.length === 0) return null;
  // Prefer london over newyork in the overlap; otherwise the first in SESSIONS order.
  const order: SessionName[] = ["london", "newyork", "tokyo", "sydney"];
  for (const name of order) {
    if (containing.some((s) => s.name === name)) return name;
  }
  return containing[0]!.name;
  void spans;
}

/** Every session containing `time` — the overlap returns two. */
export function sessionAtAll(time: number, only?: readonly SessionName[]): SessionName[] {
  const containing = sessionSpans(time - 86_400, time + 86_400, only ? { only } : {})
    .filter((s) => time >= s.from && time < s.to);
  const names = new Set(containing.map((s) => s.name));
  return SESSIONS.map((s) => s.name).filter((n) => names.has(n));
}

/** Is this time in the London/New York overlap (the most liquid window)? */
export function inOverlap(time: number): boolean {
  const all = sessionAtAll(time);
  return all.includes("london") && all.includes("newyork");
}

export interface SessionStat {
  session: SessionName | "off";
  count: number;
  netPnl: number;
  wins: number;
  winRate: number;
}

/**
 * Group trades by the session they were OPENED in.
 *
 * Entry time rather than exit: the decision was made in that session, and a trade carried
 * into another session did not become a different trade.
 */
export function sessionStats(
  trades: ReadonlyArray<{ entryTime: number; pnl: number }>,
): SessionStat[] {
  const buckets = new Map<SessionName | "off", { count: number; net: number; wins: number }>();

  for (const t of trades) {
    const s = sessionAt(t.entryTime) ?? "off";
    const b = buckets.get(s) ?? { count: 0, net: 0, wins: 0 };
    b.count++;
    b.net += t.pnl;
    if (t.pnl > 0) b.wins++;
    buckets.set(s, b);
  }

  const order: Array<SessionName | "off"> = ["sydney", "tokyo", "london", "newyork", "off"];
  const out: SessionStat[] = [];
  for (const name of order) {
    const b = buckets.get(name);
    if (!b) continue;
    out.push({
      session: name,
      count: b.count,
      netPnl: b.net,
      wins: b.wins,
      winRate: b.count > 0 ? (b.wins / b.count) * 100 : 0,
    });
  }
  return out;
}

/** Human label for a session, for the panel and the chart. */
export function sessionLabel(name: SessionName | "off"): string {
  switch (name) {
    case "sydney": return "Sydney";
    case "tokyo": return "Tokyo";
    case "london": return "London";
    case "newyork": return "New York";
    default: return "off-session";
  }
}
