/**
 * Data provider abstraction.
 *
 * The app must work in two modes and the difference must not leak into the
 * chart, the backtester or the replay engine:
 *
 *   ONLINE  - history is backfilled and quotes are polled from a remote source.
 *   OFFLINE - every read is served from the local cache or an imported file.
 *
 * So the contract here is intentionally narrow: fetch history, optionally
 * stream quotes, and report symbols. Anything network-shaped lives behind it, and
 * the rest of the app never knows whether bytes came from the internet or disk.
 *
 * Failure semantics matter more than success here: a provider that throws on a
 * flaky network would kill the chart mid-session, so every method returns a
 * Result instead of throwing, and the orchestrator decides what to do.
 */
import type { Candle } from "./types.js";

export type ProviderId = "yahoo" | "stooq" | "cache" | "file";

export interface SymbolInfo {
  /** provider-native symbol, e.g. "GC=F" or "XAUUSD" */
  id: string;
  /** human label shown in the picker */
  label: string;
  /** FX, metal, index, crypto, stock */
  kind: string;
  /** quote currency, when known */
  currency?: string;
}

export interface HistoryRequest {
  symbol: string;
  /** bars are fetched for this interval, expressed in minutes (1, 5, 60, 1440) */
  intervalMinutes: number;
  /** inclusive UTC epoch seconds; 0 means "as far back as the provider gives" */
  from: number;
  /** inclusive UTC epoch seconds; 0 means "now" */
  to: number;
}

export interface HistoryResult {
  ok: true;
  candles: Candle[];
  /** which provider actually answered (may differ from the requested one) */
  servedBy: ProviderId;
  /** true when the data came from the local cache, not the network */
  fromCache: boolean;
  /** any non-fatal notes, e.g. "provider skipped weekend rows" */
  notes: string[];
}

export interface ProviderError {
  ok: false;
  code:
    | "offline"
    | "network"
    | "not-found"
    | "rate-limited"
    | "bad-payload"
    | "unsupported";
  message: string;
  /** milliseconds to wait before retrying, when the provider says so */
  retryAfterMs?: number;
}

export type HistoryOutcome = HistoryResult | ProviderError;

/** A quote tick, for the live mode. */
export interface Quote {
  symbol: string;
  /** UTC epoch seconds */
  time: number;
  price: number;
  /** previous close, when the provider supplies it */
  previousClose?: number;
}

export interface DataProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** minutes this provider can serve natively; 0 = anything via aggregation */
  supportedIntervals(): number[];
  listSymbols(): Promise<SymbolInfo[]>;
  history(req: HistoryRequest): Promise<HistoryOutcome>;
}

/** Normalise an interval to one a provider actually offers. */
export function pickInterval(
  wanted: number,
  supported: readonly number[],
): number | null {
  if (supported.includes(wanted)) return wanted;
  // otherwise choose the largest supported interval that divides evenly and is
  // below the wanted one, so we can aggregate up to the target.
  const candidates = supported
    .filter((m) => m < wanted && wanted % m === 0)
    .sort((a, b) => b - a);
  return candidates[0] ?? null;
}

/** Sort, de-duplicate by timestamp, and drop bars with impossible geometry. */
export function sanitizeCandles(input: readonly Candle[]): {
  candles: Candle[];
  dropped: number;
} {
  const byTime = new Map<number, Candle>();
  let dropped = 0;
  for (const c of input) {
    if (
      !Number.isFinite(c.time) ||
      !Number.isFinite(c.open) ||
      !Number.isFinite(c.high) ||
      !Number.isFinite(c.low) ||
      !Number.isFinite(c.close) ||
      c.high < c.low ||
      c.high < c.open ||
      c.high < c.close ||
      c.low > c.open ||
      c.low > c.close
    ) {
      dropped++;
      continue;
    }
    byTime.set(c.time, c); // later duplicate wins
  }
  const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
  return { candles, dropped };
}
