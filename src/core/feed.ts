/**
 * Feed orchestration: the piece that makes "online = live, offline = replay"
 * one code path instead of two apps.
 *
 * Responsibilities:
 *   - decide online vs offline (never throw when the network is gone);
 *   - read through a cache so a reconnect does not refetch years of bars;
 *   - fall back to cache immediately on rate-limit instead of hammering;
 *   - report a single honest state the UI can render.
 *
 * The providers and the clock are injected, which is what makes every branch
 * testable without a network or a real wall clock.
 */
import type { Candle, CandleSeries } from "./types.js";
import type {
  DataProvider, HistoryOutcome, HistoryRequest, ProviderId,
} from "./provider.js";
import { seriesFromCandles } from "./series.js";

export type FeedMode = "online" | "offline";
export type FeedState = "idle" | "loading" | "live" | "degraded" | "offline" | "error";

export interface CacheEntry {
  symbol: string;
  intervalMinutes: number;
  candles: Candle[];
  /** when this entry was written, ms since epoch */
  fetchedAt: number;
}

/** Minimal cache contract so tests can use an in-memory map. */
export interface CandleCache {
  get(symbol: string, intervalMinutes: number): CacheEntry | undefined;
  put(entry: CacheEntry): void;
}

export class MemoryCache implements CandleCache {
  private map = new Map<string, CacheEntry>();
  private key(s: string, i: number): string {
    return `${s}|${i}`;
  }
  get(symbol: string, intervalMinutes: number): CacheEntry | undefined {
    return this.map.get(this.key(symbol, intervalMinutes));
  }
  put(entry: CacheEntry): void {
    this.map.set(this.key(entry.symbol, entry.intervalMinutes), entry);
  }
  size(): number {
    return this.map.size;
  }
}

export interface FeedStatus {
  state: FeedState;
  mode: FeedMode;
  servedBy: ProviderId | null;
  fromCache: boolean;
  barCount: number;
  message: string;
  /** true when the user can still replay/backtest with what is loaded */
  usable: boolean;
}

export interface LoadOptions {
  symbol: string;
  intervalMinutes: number;
  /** requested window; 0/0 means provider default */
  from?: number;
  to?: number;
  /** force cache-only, ignoring the network even when it exists */
  offline?: boolean;
  /** treat cache younger than this as fresh (ms); default 5 minutes */
  cacheTtlMs?: number;
}

export interface LoadResult {
  series: CandleSeries;
  status: FeedStatus;
}

/** Merge two ascending candle lists, later values winning on equal timestamps. */
export function mergeCandles(a: readonly Candle[], b: readonly Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const c of a) map.set(c.time, c);
  for (const c of b) map.set(c.time, c);
  return [...map.values()].sort((x, y) => x.time - y.time);
}

export class Feed {
  constructor(
    private provider: DataProvider,
    private cache: CandleCache,
    private now: () => number = () => Date.now(),
  ) {}

  /**
   * Load history with cache-first and graceful degradation.
   *
   * Order of events:
   *   1. fresh cache -> serve it, no network at all (this is what keeps the app
   *      instant on repeat opens and completely usable offline);
   *   2. otherwise try the provider;
   *   3. on any provider failure, fall back to stale cache if present and mark
   *      the state `degraded` rather than `error`, because the user can still
   *      replay and backtest what is already on disk.
   */
  async load(opts: LoadOptions): Promise<LoadResult> {
    const ttl = opts.cacheTtlMs ?? 5 * 60 * 1000;
    const cached = this.cache.get(opts.symbol, opts.intervalMinutes);
    const fresh = cached !== undefined && this.now() - cached.fetchedAt < ttl;

    if (cached && (fresh || opts.offline)) {
      return {
        series: seriesFromCandles(cached.candles),
        status: {
          state: opts.offline ? "offline" : "live",
          mode: "offline",
          servedBy: "cache",
          fromCache: true,
          barCount: cached.candles.length,
          message: opts.offline
            ? "Offline: replaying cached history"
            : "Serving cached history",
          usable: cached.candles.length > 0,
        },
      };
    }

    if (opts.offline) {
      return {
        series: seriesFromCandles(cached?.candles ?? []),
        status: {
          state: cached ? "offline" : "error",
          mode: "offline",
          servedBy: cached ? "cache" : null,
          fromCache: cached !== undefined,
          barCount: cached?.candles.length ?? 0,
          message: cached
            ? "Offline: replaying cached history"
            : "Offline and nothing cached for this symbol - import a CSV",
          usable: (cached?.candles.length ?? 0) > 0,
        },
      };
    }

    const req: HistoryRequest = {
      symbol: opts.symbol,
      intervalMinutes: opts.intervalMinutes,
      from: opts.from ?? 0,
      to: opts.to ?? 0,
    };

    let outcome: HistoryOutcome;
    try {
      outcome = await this.provider.history(req);
    } catch (e) {
      outcome = { ok: false, code: "network", message: (e as Error).message };
    }

    if (outcome.ok) {
      const merged = cached
        ? mergeCandles(cached.candles, outcome.candles)
        : outcome.candles;
      this.cache.put({
        symbol: opts.symbol,
        intervalMinutes: opts.intervalMinutes,
        candles: merged,
        fetchedAt: this.now(),
      });
      return {
        series: seriesFromCandles(merged),
        status: {
          state: "live",
          mode: "online",
          servedBy: outcome.servedBy,
          fromCache: false,
          barCount: merged.length,
          message:
            outcome.notes.length > 0
              ? `Live (${outcome.servedBy}); ${outcome.notes.join("; ")}`
              : `Live from ${outcome.servedBy}`,
          usable: merged.length > 0,
        },
      };
    }

    // Provider failed. Degrade to whatever is cached.
    const stale = cached?.candles ?? [];
    return {
      series: seriesFromCandles(stale),
      status: {
        state: stale.length > 0 ? "degraded" : "error",
        mode: "online",
        servedBy: stale.length > 0 ? "cache" : null,
        fromCache: stale.length > 0,
        barCount: stale.length,
        message:
          stale.length > 0
            ? `${describeError(outcome)} - using cached history (${stale.length} bars)`
            : describeError(outcome),
        usable: stale.length > 0,
      },
    };
  }

  /**
   * Append a freshly polled quote as the forming bar.
   *
   * Replay and backtest must not see a bar that is still moving, so the caller
   * treats this as "the last bar is provisional" rather than writing it into a
   * closed series.
   */
  applyQuote(series: CandleSeries, quote: { time: number; price: number }): CandleSeries {
    const n = series.length;
    const out: CandleSeries = {
      time: new Float64Array(n + 1),
      open: new Float64Array(n + 1),
      high: new Float64Array(n + 1),
      low: new Float64Array(n + 1),
      close: new Float64Array(n + 1),
      volume: new Float64Array(n + 1),
      length: n + 1,
    };
    out.time.set(series.time);
    out.open.set(series.open);
    out.high.set(series.high);
    out.low.set(series.low);
    out.close.set(series.close);
    out.volume.set(series.volume);
    const last = n > 0 ? series.close[n - 1]! : quote.price;
    out.time[n] = quote.time;
    out.open[n] = last;
    out.high[n] = Math.max(last, quote.price);
    out.low[n] = Math.min(last, quote.price);
    out.close[n] = quote.price;
    out.volume[n] = 0;
    return out;
  }
}

function describeError(e: Exclude<HistoryOutcome, { ok: true }>): string {
  switch (e.code) {
    case "offline": return "No network connection";
    case "network": return `Network error: ${e.message}`;
    case "not-found": return e.message;
    case "rate-limited": return "Provider rate limit hit";
    case "bad-payload": return `Provider returned bad data: ${e.message}`;
    case "unsupported": return e.message;
  }
}
