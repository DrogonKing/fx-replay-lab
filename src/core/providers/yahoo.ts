/**
 * Yahoo Finance chart adapter.
 *
 * Why Yahoo: it is the only free source that serves intraday FX, metals, indices
 * and crypto under one symbol space, with no key. The endpoint used is the public
 * `v8/finance/chart` JSON, which returns parallel arrays that map cleanly onto
 * the columnar CandleSeries.
 *
 * Two real-world behaviours are handled explicitly because they cause silent
 * corruption otherwise:
 *
 * 1. NOT every symbol exists. `XAUUSD=X` 404s on Yahoo; spot gold is `GC=F`
 *    (futures). A wrong symbol must surface as `not-found`, never as an empty
 *    chart that looks like a data gap.
 * 2. Yahoo rate-limits aggressively and answers 429 with no body. That is
 *    reported as `rate-limited` with a retry hint, and the orchestrator falls
 *    back to cache instead of retrying in a loop.
 *
 * The transport is injected so tests run without a network.
 */
import type { Candle } from "../types.js";
import type {
  DataProvider, HistoryOutcome, HistoryRequest, ProviderId, SymbolInfo,
} from "../provider.js";
import { sanitizeCandles } from "../provider.js";

export interface HttpResponse {
  status: number;
  /** parsed JSON when content-type is JSON, else raw text */
  body: unknown;
  /** Retry-After header in seconds, when present */
  retryAfterSeconds?: number;
}

export type Transport = (url: string, headers: Record<string, string>) => Promise<HttpResponse>;

const BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

/**
 * Yahoo's native interval tokens, keyed by MINUTES.
 *
 * Yahoo has no 4-hour interval, so 240 intentionally has no entry: the caller
 * asks for 60m and aggregates up (see pickInterval). Listing 240 -> "1h" would
 * silently return hourly data labelled as 4-hourly, which corrupts every
 * timeframe-dependent calculation built on top of it.
 */
const INTERVALS: Record<number, string> = {
  1: "1m",
  5: "5m",
  15: "15m",
  30: "30m",
  60: "60m",
  1440: "1d",
  10080: "1wk",
};

/** Symbols worth offering in the picker, chosen for this user's instruments. */
export const YAHOO_SYMBOLS: SymbolInfo[] = [
  { id: "GC=F", label: "Gold futures (XAUUSD proxy)", kind: "metal", currency: "USD" },
  { id: "EURUSD=X", label: "EUR/USD", kind: "fx", currency: "USD" },
  { id: "GBPUSD=X", label: "GBP/USD", kind: "fx", currency: "USD" },
  { id: "USDJPY=X", label: "USD/JPY", kind: "fx", currency: "JPY" },
  { id: "BTC-USD", label: "Bitcoin / USD", kind: "crypto", currency: "USD" },
  { id: "^GSPC", label: "S&P 500", kind: "index", currency: "USD" },
  { id: "^NDX", label: "Nasdaq 100", kind: "index", currency: "USD" },
  { id: "SPY", label: "SPY ETF", kind: "etf", currency: "USD" },
];

/** Known traps: symbols users ask for that Yahoo does not serve. */
export const YAHOO_ALIASES: Record<string, string> = {
  XAUUSD: "GC=F",
  "XAU/USD": "GC=F",
  GOLD: "GC=F",
  XAGUSD: "SI=F",
  US30: "^DJI",
  NAS100: "^NDX",
  SPX500: "^GSPC",
};

export function resolveSymbol(raw: string): string {
  const key = raw.trim().toUpperCase();
  return YAHOO_ALIASES[key] ?? raw.trim();
}

interface YahooChart {
  chart?: {
    result?: Array<{
      meta?: { symbol?: string; currency?: string };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }>;
      };
    }>;
    error?: { code?: string; description?: string } | null;
  };
}

export class YahooProvider implements DataProvider {
  readonly id: ProviderId = "yahoo";
  readonly label = "Yahoo Finance";

  constructor(private transport: Transport) {}

  supportedIntervals(): number[] {
    return Object.keys(INTERVALS).map(Number).sort((a, b) => a - b);
  }

  async listSymbols(): Promise<SymbolInfo[]> {
    return YAHOO_SYMBOLS;
  }

  async history(req: HistoryRequest): Promise<HistoryOutcome> {
    const yahooInterval = INTERVALS[req.intervalMinutes];
    if (!yahooInterval) {
      // Covers 240m and odd frames like 7m: return unsupported so the caller
      // aggregates from a native interval instead of receiving mislabelled data.
      return {
        ok: false,
        code: "unsupported",
        message: `Yahoo cannot serve ${req.intervalMinutes}m; aggregate from a smaller interval`,
      };
    }
    const nativeInterval = yahooInterval;

    const symbol = resolveSymbol(req.symbol);
    const params = new URLSearchParams({
      interval: nativeInterval,
      includePrePost: "false",
      events: "div,splits",
    });
    // Yahoo requires a period1/period2 window for intraday history.
    const to = req.to > 0 ? req.to : Math.floor(Date.now() / 1000);
    const from = req.from > 0 ? req.from : to - 60 * 86400;
    params.set("period1", String(from));
    params.set("period2", String(to));

    const url = `${BASE}/${encodeURIComponent(symbol)}?${params.toString()}`;

    let res: HttpResponse;
    try {
      res = await this.transport(url, {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/json",
      });
    } catch (e) {
      return { ok: false, code: "network", message: (e as Error).message };
    }

    if (res.status === 429) {
      return {
        ok: false,
        code: "rate-limited",
        message: "Yahoo rate limit hit",
        retryAfterMs: (res.retryAfterSeconds ?? 30) * 1000,
      };
    }
    if (res.status === 404) {
      return {
        ok: false,
        code: "not-found",
        message: `Yahoo has no symbol ${symbol}`,
      };
    }
    if (res.status >= 400) {
      return {
        ok: false,
        code: "network",
        message: `Yahoo returned HTTP ${res.status}`,
      };
    }

    const data = res.body as YahooChart;
    const result = data?.chart?.result?.[0];
    if (!result) {
      const desc = data?.chart?.error?.description ?? "empty response";
      return { ok: false, code: "bad-payload", message: desc };
    }

    const ts = result.timestamp ?? [];
    const q = result.indicators?.quote?.[0] ?? {};
    const candles: Candle[] = [];
    const notes: string[] = [];

    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i];
      const h = q.high?.[i];
      const l = q.low?.[i];
      const c = q.close?.[i];
      // Yahoo emits nulls for bars with no trades; skipping them is correct,
      // inventing a flat bar there would fake liquidity that never existed.
      if (o == null || h == null || l == null || c == null) continue;
      candles.push({
        time: ts[i]!,
        open: o,
        high: h,
        low: l,
        close: c,
        volume: q.volume?.[i] ?? 0,
      });
    }

    const { candles: clean, dropped } = sanitizeCandles(candles);
    if (dropped > 0) notes.push(`${dropped} malformed bars dropped`);
    if (clean.length === 0) {
      return {
        ok: false,
        code: "bad-payload",
        message: "Yahoo returned no usable bars for this window",
      };
    }
    return { ok: true, candles: clean, servedBy: this.id, fromCache: false, notes };
  }
}
