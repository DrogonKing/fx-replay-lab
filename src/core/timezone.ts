/**
 * Timezone handling.
 *
 * Requirements from the spec:
 *  - all stored times are UTC epoch seconds;
 *  - the display zone is chosen in-app and is INDEPENDENT of the OS zone;
 *  - IANA zones with correct DST, offset recomputed per bar.
 *
 * Implementation: use the platform Intl API rather than a bundled tz database.
 * Intl carries the full IANA database and applies DST correctly, and it avoids
 * shipping ~2 MB of tz data that would need updating. The cost is that each
 * conversion goes through formatToParts, so offsets are cached per hour to keep
 * chart label generation cheap.
 */

export const TIMEZONES = [
  "UTC",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tehran",
  "Asia/Dubai",
  "Asia/Tokyo",
  "Australia/Sydney",
] as const;

export type TimezoneName = (typeof TIMEZONES)[number] | string;

const HOUR = 3600;

/** Cache of "zone|epochHour" -> offset seconds. Bounded by usage per chart render. */
const offsetCache = new Map<string, number>();

/**
 * Offset of `zone` from UTC at `epochSeconds`, in seconds (east positive).
 * New York in winter returns -18000, in summer -14400.
 */
export function zoneOffsetSeconds(epochSeconds: number, zone: string): number {
  if (zone === "UTC" || zone === "Etc/UTC") return 0;
  const hourBucket = Math.floor(epochSeconds / HOUR);
  const key = `${zone}|${hourBucket}`;
  const hit = offsetCache.get(key);
  if (hit !== undefined) return hit;

  const dtf = getFormatter(zone);
  const parts = dtf.formatToParts(new Date(epochSeconds * 1000));
  let y = 0, mo = 1, d = 1, h = 0, mi = 0, s = 0;
  for (const p of parts) {
    switch (p.type) {
      case "year": y = Number(p.value); break;
      case "month": mo = Number(p.value); break;
      case "day": d = Number(p.value); break;
      case "hour": h = Number(p.value); break;
      case "minute": mi = Number(p.value); break;
      case "second": s = Number(p.value); break;
      default: break;
    }
  }
  // hour can be "24" in some locales at midnight
  const hour = h === 24 ? 0 : h;
  const asUtc = Date.UTC(y, mo - 1, d, hour, mi, s) / 1000;
  const offset = asUtc - epochSeconds;
  // Round to whole minutes: IANA offsets are always whole minutes.
  const rounded = Math.round(offset / 60) * 60;
  offsetCache.set(key, rounded);
  return rounded;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function getFormatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    formatters.set(zone, f);
  }
  return f;
}

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday */
  weekday: number;
}

/** Convert UTC epoch seconds into wall-clock fields in `zone`. */
export function toWallClock(epochSeconds: number, zone: string): WallClock {
  const off = zoneOffsetSeconds(epochSeconds, zone);
  const shifted = epochSeconds + off;
  const d = new Date(shifted * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  };
}

/**
 * Inverse of toWallClock: wall-clock fields in `zone` -> UTC epoch seconds.
 *
 * DST makes this ambiguous twice a year: one wall time occurs twice when clocks
 * go back, and not at all when they jump forward. We resolve by computing the
 * offset for the naive UTC guess and, if it disagrees, correcting once -- the
 * standard two-pass approach. A non-existent time is pushed forward by the gap.
 */
export function fromWallClock(w: WallClock, zone: string): number {
  const naive = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) / 1000;
  const off1 = zoneOffsetSeconds(naive, zone);
  const c1 = naive - off1;
  const off2 = zoneOffsetSeconds(c1, zone);
  if (off2 === off1) return c1;              // unambiguous: single pass is exact

  // The two passes disagree, so this wall time sits in a DST transition and the
  // choice of offset changes the answer.
  const c2 = naive - off2;
  //
  // Picking min() or max() of the two candidates is wrong: a spring-forward GAP
  // and a fall-back OVERLAP need
  // opposite resolutions, so a single min/max rule breaks one of them.
  //
  // Resolve with the offset that was in effect BEFORE the transition window.
  // That single rule gives the right answer in both cases:
  //   * gap  (02:30 does not exist, clocks 02:00->03:00):
  //       naive - offBefore = 02:30 - (-5) = 07:30Z, which renders 03:30 EDT,
  //       i.e. shifted forward by the gap -- the "compatible" disambiguation
  //       used by Temporal and most libraries.
  //   * overlap (01:30 happens twice, clocks 02:00->01:00):
  //       naive - offBefore = 01:30 - (-4) = 05:30Z, the FIRST occurrence, which
  //       is the conventional choice.
  //
  // Consequence: a round trip through an OVERLAP is not injective -- the caller
  // cannot recover which of the two instants it started from. That is a property
  // of wall-clock time, not a defect. A round trip through a GAP returns the
  // shifted-forward instant, never a non-existent one.
  const offBefore = zoneOffsetSeconds(naive - 86400, zone);
  const byBefore = naive - offBefore;
  // Guard the rare case of two transitions inside 48h (some historical zones):
  // if the pre-window offset does not reproduce the requested wall time and the
  // other candidate does, prefer the one that actually renders correctly.
  const beforeOk = zoneOffsetSeconds(byBefore, zone) === offBefore;
  if (beforeOk) return byBefore;
  return Math.abs(zoneOffsetSeconds(c1, zone) - off1) <=
    Math.abs(zoneOffsetSeconds(c2, zone) - off2)
    ? c1
    : c2;
}

/** "2024-01-02 15:04" in the display zone. */
export function formatDateTime(epochSeconds: number, zone: string): string {
  const w = toWallClock(epochSeconds, zone);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${w.year}-${p2(w.month)}-${p2(w.day)} ${p2(w.hour)}:${p2(w.minute)}`;
}

/** "15:04" in the display zone. */
export function formatTime(epochSeconds: number, zone: string): string {
  const w = toWallClock(epochSeconds, zone);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(w.hour)}:${p2(w.minute)}`;
}

/** Short label for an hour offset, e.g. "UTC+3:30". */
export function formatOffset(epochSeconds: number, zone: string): string {
  const off = zoneOffsetSeconds(epochSeconds, zone);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(m).padStart(2, "0")}`;
}

/** True when the zone is currently observing DST (offset differs from January). */
export function isDst(epochSeconds: number, zone: string): boolean {
  if (zone === "UTC") return false;
  const w = toWallClock(epochSeconds, zone);
  const jan = fromWallClock({ ...w, month: 1, day: 15 }, zone);
  const jul = fromWallClock({ ...w, month: 7, day: 15 }, zone);
  const now = zoneOffsetSeconds(epochSeconds, zone);
  const standard = Math.min(zoneOffsetSeconds(jan, zone), zoneOffsetSeconds(jul, zone));
  return now > standard;
}
