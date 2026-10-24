/**
 * MetaTrader live feed.
 *
 * When an MT account is connected, `mtLatest` replaces Yahoo as the live source.
 * One poll asks the terminal for a trailing window of bars and hands them back as a
 * plain `LoadResult` — the SAME shape the Yahoo feed produces — so App's existing
 * merge/accounting path (`mergeSeries` + last-processed tracking) consumes MT bars
 * without a second copy of that logic. The feed machinery is reused, not forked.
 *
 * Poll cadence: 5s for the frames a trader watches tick-by-tick (M1–M5), 15s above.
 */
import { seriesFromCandles } from "../core/series.js";
import type { LoadResult } from "../core/feed.js";
import type { Candle } from "../core/types.js";

type MtCandle = {
  time: number; open: number; high: number; low: number; close: number; volume: number;
};

interface MtApi {
  mtLatest?: (req: {
    symbol: string; timeframe: string; count: number;
  }) => Promise<{ ok: boolean; candles?: MtCandle[]; error?: string }>;
}

function api(): MtApi {
  return (globalThis as unknown as { fxlab?: MtApi }).fxlab ?? {};
}

/** How many trailing bars one poll asks for — enough to overlap, few enough to be instant. */
const POLL_COUNT = 300;

/** Seconds between polls: fast on the sub-hour frames a replay trader watches form. */
export function mtPollSeconds(timeframe: string): number {
  return mtTimeframeMinutes(timeframe) <= 5 ? 5 : 15;
}

/** "M15" -> 15, "H4" -> 240, "D1" -> 1440; 1 for anything unparseable. */
export function mtTimeframeMinutes(tf: string): number {
  const m = /^([MHDW])(\d+)$/i.exec(tf.trim());
  if (!m) return 1;
  const n = Number(m[2]);
  switch (m[1]!.toUpperCase()) {
    case "M": return n;
    case "H": return n * 60;
    case "D": return n * 1440;
    case "W": return n * 10080;
    default: return 1;
  }
}

/** A minute count -> the MT label: 5 -> "M5", 60 -> "H1", 1440 -> "D1". */
export function mtTimeframeLabel(minutes: number): string {
  if (minutes >= 10080) return `W${Math.max(1, Math.round(minutes / 10080))}`;
  if (minutes >= 1440) return `D${Math.max(1, Math.round(minutes / 1440))}`;
  if (minutes >= 60) return `H${Math.max(1, Math.round(minutes / 60))}`;
  return `M${Math.max(1, Math.round(minutes))}`;
}

/**
 * Map an app symbol id to the name a MetaTrader terminal quotes.
 *
 * Provider ids carry suffixes ("EURUSD=X", "GC=F"); the terminal does not.
 */
export function mtSymbolName(appId: string): string {
  if (appId.startsWith("GC=F")) return "XAUUSD";
  return appId.replace(/=[XF]$/, "");
}

/**
 * One live poll. Throws on failure so the caller's existing catch can report it —
 * the Yahoo poll has the same contract.
 */
export async function pollMtLive(symbol: string, timeframe: string): Promise<LoadResult> {
  const a = api();
  if (!a.mtLatest) throw new Error("MetaTrader is not available in this build");
  const r = await a.mtLatest({ symbol, timeframe, count: POLL_COUNT });
  if (!r.ok || !r.candles || r.candles.length === 0) {
    throw new Error(r.error ?? "no bars returned from MetaTrader");
  }
  const candles: Candle[] = [...r.candles];
  candles.sort((x, y) => x.time - y.time);
  return {
    series: seriesFromCandles(candles),
    status: {
      state: "live",
      mode: "online",
      // ProviderId is a closed union for the HTTP providers; MT is not one of them,
      // so the source is carried in the message instead of pretending an id.
      servedBy: null,
      fromCache: false,
      barCount: candles.length,
      message: `Live (MetaTrader) · ${symbol} ${timeframe}`,
      usable: true,
    },
  };
}
