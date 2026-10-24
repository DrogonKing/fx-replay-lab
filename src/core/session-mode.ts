/**
 * Session mode: live paper trading, or replay of the past.
 *
 * Two modes share one account engine, one chart and one trade panel. The difference is only
 * where the bars come from and whether the clock moves on its own.
 *
 * The hard part is not the toggle — it is answering "can I replay 2019 at 5 minutes?" honestly.
 * Yahoo keeps intraday history for a limited window, and pretending otherwise would produce a
 * replay that silently starts in the wrong year. `availability()` is the single place that
 * knows the limits, and the UI asks it instead of guessing.
 */
import type { Candle } from "./types.js";

export type SessionMode = "live" | "replay";

/**
 * How far back each interval actually goes on the free Yahoo endpoint.
 *
 * These are real limits, not preferences. Yahoo's chart endpoint refuses an intraday window
 * that reaches further back, so asking for 5-minute data from 2019 returns nothing — and a
 * loader that ignored that would look like a broken download rather than a provider limit.
 *
 *  1m  — about 7 days
 *  5m  — about 60 days
 * 15m  — about 60 days
 * 30m  — about 60 days
 * 60m  — about 730 days
 *  1d  — full history
 */
export const INTRADAY_LIMIT_DAYS: Record<number, number> = {
  1: 7,
  5: 60,
  15: 60,
  30: 60,
  60: 730,
  1440: 365 * 30,
  10080: 365 * 30,
};

/**
 * Below this many days of history, a replay is not worth offering: the user asked for a year
 * and would get a fortnight. Chosen so 1-minute data (7 days) needs a file while 5-minute data
 * (60 days) can be clamped honestly.
 */
export const MIN_REPLAY_DAYS = 14;

export type AvailabilityVerdict =
  /** the provider can serve the whole range */
  | "ok"
  /** the provider can serve part of it; `clampedFrom` is the oldest bar available */
  | "clamped"
  /** the provider has none of it; the user must import a file */
  | "needs-file"
  /** the interval is not offered at all */
  | "unsupported-interval";

export interface Availability {
  verdict: AvailabilityVerdict;
  /** oldest epoch second the provider can serve, when clamped */
  clampedFrom?: number;
  /** how many days of history the interval allows */
  limitDays: number;
  /** plain-language explanation, shown next to the picker */
  message: string;
}

/**
 * Can the provider serve `intervalMinutes` back to `fromEpoch`?
 *
 * `now` is injected rather than read from the clock so this is testable and so a replay does
 * not shift meaning depending on when the app is opened.
 */
/**
 * The finest resolution that can cover a window.
 *
 * The start screen does not ask for a timeframe, because asking forces a choice before any data
 * exists AND caps the user at it: pick 5m and 1m is gone forever. So the app loads the FINEST
 * data its provider can serve for the window it was asked for, and derives every coarser frame
 * (plus custom ones) by aggregation.
 *
 * Order matters: 1m is tried first because it gives the most derived frames, and the provider's
 * own retention is what decides. A year-long window cannot have 1m — nothing keeps a year of it
 * for free — so it lands on the coarsest interval that does cover it.
 */
export function finestFor(fromEpoch: number, now: number): number {
  const windowDays = Math.max(1, Math.ceil((now - fromEpoch) / 86400));
  // finest first: more bars is strictly better, since aggregation only goes one way
  const candidates = Object.keys(INTRADAY_LIMIT_DAYS)
    .map(Number)
    .sort((a, b) => a - b);

  for (const minutes of candidates) {
    const limit = INTRADAY_LIMIT_DAYS[minutes]!;
    if (limit >= windowDays) return minutes;
  }
  // nothing intraday covers it: daily is the widest the provider has
  return 1440;
}

export function availability(
  intervalMinutes: number,
  fromEpoch: number,
  now: number,
): Availability {
  const limitDays = INTRADAY_LIMIT_DAYS[intervalMinutes];
  if (limitDays === undefined) {
    return {
      verdict: "unsupported-interval",
      limitDays: 0,
      message: `The provider does not offer ${intervalMinutes}-minute data.`,
    };
  }

  const oldest = now - limitDays * 86400;
  if (fromEpoch >= oldest) {
    return {
      verdict: "ok",
      limitDays,
      message: `${intervalMinutes >= 1440 ? "Daily" : `${intervalMinutes}-minute`} history covers this range.`,
    };
  }

  // A window shorter than two weeks is not enough to replay anything meaningful, so offering
  // "start from the oldest available" would be a polite lie: the user asked for a year and
  // would get a fortnight. Below that threshold a file is the only honest answer.
  //
  // This threshold is a judgement call, not a provider fact — unlike `limitDays`, which is.
  if (limitDays < MIN_REPLAY_DAYS) {
    return {
      verdict: "needs-file",
      limitDays,
      message: `The provider keeps only ${limitDays} day(s) of ${intervalMinutes}-minute data, which is too short to replay. Import a file for this range.`,
    };
  }

  return {
    verdict: "clamped",
    clampedFrom: oldest,
    limitDays,
    message:
      `The provider keeps ${limitDays} days of ${intervalMinutes}-minute data, so the replay ` +
      `starts at ${new Date(oldest * 1000).toISOString().slice(0, 10)} instead of the requested date.`,
  };
}

/** The epoch second to actually request, after clamping. */
export function effectiveFrom(fromEpoch: number, a: Availability): number {
  return a.clampedFrom !== undefined ? Math.max(fromEpoch, a.clampedFrom) : fromEpoch;
}

/**
 * Merge newly fetched bars into an existing series.
 *
 * Live polling re-requests a trailing window, so the response always overlaps what is already
 * held. Appending blindly would duplicate bars, and the account engine would then process the
 * same bar twice — charging commission twice and advancing swap twice.
 *
 * The last bar is also REPLACED rather than appended, because the most recent bar of a live
 * feed is still forming: its close changes with every poll.
 */
export function mergeBars(existing: readonly Candle[], incoming: readonly Candle[]): Candle[] {
  const a = mergeBarsObject(existing, incoming);
  return a;
}

/** Object-array merge; see `mergeSeries` for the typed-array form the app actually uses. */
export function mergeBarsObject(existing: readonly Candle[], incoming: readonly Candle[]): Candle[] {
  if (existing.length === 0) return [...incoming];
  if (incoming.length === 0) return [...existing];

  const lastTime = existing[existing.length - 1]!.time;
  const out = [...existing];

  for (const bar of incoming) {
    if (bar.time > lastTime) {
      out.push(bar);
    } else if (bar.time === lastTime) {
      // the forming bar: take the newer values
      out[out.length - 1] = bar;
    }
    // older bars are already known; a live poll must not rewrite history
  }

  return out;
}

/** The app's bar container: parallel typed arrays, one entry per bar. */
export interface SeriesLike {
  time: ArrayLike<number>;
  open: ArrayLike<number>;
  high: ArrayLike<number>;
  low: ArrayLike<number>;
  close: ArrayLike<number>;
  volume: ArrayLike<number>;
}

/**
 * Merge at the typed-array level.
 *
 * The app holds bars as parallel typed arrays (a `CandleSeries`), so merging object arrays
 * would copy 30k bars into objects and back on every poll — four times a minute, forever.
 * This keeps the same shape and only rebuilds when something actually changed.
 */
export function mergeSeries<T extends SeriesLike>(existing: T, incoming: SeriesLike): T {
  if (existing.time.length === 0) {
    return buildSeries(incoming.time, incoming.open, incoming.high, incoming.low,
      incoming.close, incoming.volume) as unknown as T;
  }
  if (incoming.time.length === 0) return existing;

  const n = existing.time.length;
  const lastTime = existing.time[n - 1]!;

  const time = Array.from(existing.time);
  const open = Array.from(existing.open);
  const high = Array.from(existing.high);
  const low = Array.from(existing.low);
  const close = Array.from(existing.close);
  const volume = Array.from(existing.volume);

  for (let i = 0; i < incoming.time.length; i++) {
    const t = incoming.time[i]!;
    if (t > lastTime) {
      time.push(t);
      open.push(incoming.open[i]!);
      high.push(incoming.high[i]!);
      low.push(incoming.low[i]!);
      close.push(incoming.close[i]!);
      volume.push(incoming.volume[i]!);
    } else if (t === lastTime) {
      // the forming bar: take the newer values, do not append
      open[open.length - 1] = incoming.open[i]!;
      high[high.length - 1] = incoming.high[i]!;
      low[low.length - 1] = incoming.low[i]!;
      close[close.length - 1] = incoming.close[i]!;
      volume[volume.length - 1] = incoming.volume[i]!;
    }
  }

  return buildSeries(time, open, high, low, close, volume) as unknown as T;
}

/**
 * Build a series, INCLUDING the `length` field.
 *
 * `CandleSeries` carries a `length` alongside its arrays, and an early version of this function
 * omitted it: `merged.length` came back undefined and the status line crashed the whole
 * renderer with "cannot read properties of undefined". The `as unknown as T` cast hid the
 * missing field from TypeScript, which is exactly what a cast that silences the compiler can
 * do. `buildSeries` is the one place that shape is assembled, so it cannot drift again.
 */
function buildSeries(
  time: ArrayLike<number>,
  open: ArrayLike<number>,
  high: ArrayLike<number>,
  low: ArrayLike<number>,
  close: ArrayLike<number>,
  volume: ArrayLike<number>,
): SeriesLike & { length: number } {
  const t = Float64Array.from(time);
  return {
    time: t,
    open: Float64Array.from(open),
    high: Float64Array.from(high),
    low: Float64Array.from(low),
    close: Float64Array.from(close),
    volume: Float64Array.from(volume),
    length: t.length,
  };
}

/**
 * Bars that appeared since the previous length, as indices.
 *
 * The account engine processes one bar per index. Re-processing a bar already seen would
 * double-charge; skipping one would leave a stop un-tested.
 */
export function newBarIndices(previousCount: number, nextCount: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, previousCount); i < nextCount; i++) out.push(i);
  return out;
}

export interface ModeState {
  mode: SessionMode;
  /** live only: seconds between polls */
  pollSeconds: number;
  /** replay only: how many bars per second while playing */
  replaySpeed: number;
}

export const DEFAULT_MODE_STATE: ModeState = {
  mode: "replay",
  pollSeconds: 15,
  replaySpeed: 4,
};

export function parseModeState(raw: unknown): ModeState {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_MODE_STATE };
  const o = raw as Partial<ModeState>;
  return {
    mode: o.mode === "live" ? "live" : "replay",
    pollSeconds:
      typeof o.pollSeconds === "number" && o.pollSeconds >= 5 && o.pollSeconds <= 300
        ? Math.round(o.pollSeconds)
        : DEFAULT_MODE_STATE.pollSeconds,
    replaySpeed:
      typeof o.replaySpeed === "number" && o.replaySpeed >= 1 && o.replaySpeed <= 100
        ? Math.round(o.replaySpeed)
        : DEFAULT_MODE_STATE.replaySpeed,
  };
}

/**
 * Should a live poll advance the account?
 *
 * Only on a CLOSED bar. A forming bar changes on every poll, so processing it repeatedly would
 * fill orders at prices that never existed and re-charge commission each time. The account
 * advances when a bar's time is strictly newer than the last one processed.
 */
export function shouldAdvanceAccount(
  lastProcessedTime: number,
  incomingLastTime: number,
  barsAdded: number,
): boolean {
  return barsAdded > 0 && incomingLastTime > lastProcessedTime;
}

/** One line describing the mode, for the status bar. */
export function describeMode(mode: SessionMode): string {
  return mode === "live"
    ? "live paper trading — orders fill on closed bars"
    : "replay — step or play through past bars";
}

/**
 * Year options for the replay picker, newest first.
 *
 * Bounded by what the interval allows, so the picker cannot offer a year the provider will
 * refuse. This is the fix for "I picked 2019 and nothing loaded".
 */
export function selectableYears(intervalMinutes: number, now: number): number[] {
  const limitDays = INTRADAY_LIMIT_DAYS[intervalMinutes] ?? 365;
  const oldest = now - limitDays * 86400;
  const firstYear = new Date(oldest * 1000).getUTCFullYear();
  const lastYear = new Date(now * 1000).getUTCFullYear();
  const out: number[] = [];
  for (let y = lastYear; y >= firstYear; y--) out.push(y);
  return out;
}
