/**
 * Broker-agnostic market data adapters.
 *
 * The request was: connect to any broker's demo account, pull candles, and never touch the
 * account itself. This is that — but the honest shape of it differs per broker, because
 * "broker" is not one protocol:
 *
 *   - MT4/MT5 have NO public HTTP API. The only supported path is the Windows terminal
 *     (or the MetaTrader5 Python package, which is win_amd64 only) attaching to a running
 *     terminal. There is no way to log in over HTTPS and ask for candles.
 *   - cTrader has a real open API (OAuth + protobuf over TCP).
 *   - OANDA has a real REST API.
 *
 * So this file defines ONE interface and adapters behind it. Adding a broker means adding an
 * adapter, not changing the app.
 *
 * Security: credentials are never stored. A login is used once, in memory, to obtain a token
 * or to attach to a terminal — and the account-balance endpoints are never called. The data
 * paths below are read-only by construction.
 */
import type { Candle } from "./types.js";

/** What the app needs from any broker: bars, and nothing else. */
export interface MarketDataAdapter {
  /** stable id, used in settings */
  id: string;
  /** shown in the broker picker */
  label: string;
  /**
   * How this adapter actually reaches the market. The UI uses this to explain why an adapter
   * needs a terminal, a token, or nothing at all.
   */
  transport: "rest" | "terminal-bridge" | "open-api";
  /** fields the user must supply, in order */
  credentials: CredentialField[];
  /** true when the adapter can only work on Windows (or under Wine) */
  windowsOnly: boolean;
  /** fetch bars, oldest first */
  fetchCandles(req: CandleRequest): Promise<Candle[]>;
}

export interface CredentialField {
  key: string;
  label: string;
  /** passwords are never persisted and never logged */
  secret?: boolean;
  placeholder?: string;
}

export interface CandleRequest {
  symbol: string;
  /** minutes; 1, 5, 15, 30, 60, 240, 1440 */
  intervalMinutes: number;
  /** epoch seconds */
  from: number;
  to: number;
}

/**
 * MT4 / MT5.
 *
 * There is no public protocol. A "login" here means: a MetaTrader terminal, already running,
 * is asked to attach to the given account and server. The terminal does the talking.
 *
 * This adapter therefore speaks to a BRIDGE process — a small program the user runs next to
 * their terminal, which exposes bars over localhost HTTP. That is the only design that works
 * for any broker, because it reuses the broker's own terminal instead of reverse-engineering
 * a proprietary protocol.
 */
export const MT5_ADAPTER: Omit<MarketDataAdapter, "fetchCandles"> = {
  id: "mt5",
  label: "MetaTrader 4 / 5 (any broker)",
  transport: "terminal-bridge",
  windowsOnly: true,
  credentials: [
    { key: "login", label: "Account number", placeholder: "12345678" },
    { key: "password", label: "Password", secret: true },
    { key: "server", label: "Server", placeholder: "ICMarkets-Demo" },
    { key: "bridgeUrl", label: "Bridge URL", placeholder: "http://127.0.0.1:8765" },
  ],
};

/** OANDA v20: a real REST API, with a practice host that costs nothing. */
export const OANDA_ADAPTER: Omit<MarketDataAdapter, "fetchCandles"> = {
  id: "oanda",
  label: "OANDA v20 (practice or live)",
  transport: "rest",
  windowsOnly: false,
  credentials: [
    { key: "token", label: "API token", secret: true },
    { key: "accountId", label: "Account ID", placeholder: "101-004-1234567-001" },
    { key: "practice", label: "Use practice host (yes/no)", placeholder: "yes" },
  ],
};

/** cTrader Open API: OAuth, protobuf over TCP. Real, but a bigger integration. */
export const CTRADER_ADAPTER: Omit<MarketDataAdapter, "fetchCandles"> = {
  id: "ctrader",
  label: "cTrader Open API",
  transport: "open-api",
  windowsOnly: false,
  credentials: [
    { key: "clientId", label: "Client ID" },
    { key: "clientSecret", label: "Client secret", secret: true },
    { key: "accessToken", label: "Access token", secret: true },
    { key: "accountId", label: "Account ID" },
  ],
};

export const ADAPTERS: Array<Omit<MarketDataAdapter, "fetchCandles">> = [
  MT5_ADAPTER,
  OANDA_ADAPTER,
  CTRADER_ADAPTER,
];

/**
 * OANDA granularity tokens, keyed by minutes.
 *
 * OANDA's own names, not Yahoo's: S5, S10, S15, S30, M1..M30, H1..H12, D, W, M. Asking for an
 * interval it does not have returns an error, so this is a closed map rather than a formula.
 */
export const OANDA_GRANULARITY: Record<number, string> = {
  1: "M1",
  5: "M5",
  15: "M15",
  30: "M30",
  60: "H1",
  240: "H4",
  1440: "D",
};

export interface OandaCandleRequest extends CandleRequest {
  /** OANDA's price component: bid, ask, or mid. This is why OANDA beats a mid-only feed. */
  price: "bid" | "ask" | "mid";
  practice: boolean;
}

/** Host for an OANDA request. Practice and live differ only in hostname. */
export function oandaHost(practice: boolean): string {
  return practice ? "api-fxpractice.oanda.com" : "api-fxtrade.oanda.com";
}

/**
 * OANDA's instrument naming: EUR_USD, not EURUSD.
 *
 * A wrong name is a 404, and every broker uses a different convention, which is why each
 * adapter owns its own symbol mapping rather than sharing one.
 */
export function oandaInstrument(symbol: string): string {
  // Yahoo writes "EURUSD=X"; the suffix must go BEFORE splitting, or stripping non-letters
  // produces a 7-character string that matches nothing and 404s at the API.
  const s = symbol
    .toUpperCase()
    .replace(/[=:].*$/, "")
    .replace(/[^A-Z0-9]/g, "");

  // every OANDA instrument is PREFIX_QUOTE with a 3-character quote currency, and every
  // symbol we care about (FX, metals, crypto crosses) is 6 characters
  if (s.length === 6) return `${s.slice(0, 3)}_${s.slice(3)}`;
  return s;
}

/** Build the candles URL. `count` is capped at 5000 by the API. */
export function oandaCandlesUrl(
  accountId: string,
  req: OandaCandleRequest,
): string {
  const gran = OANDA_GRANULARITY[req.intervalMinutes];
  if (!gran) {
    throw new Error(`OANDA has no ${req.intervalMinutes}-minute granularity`);
  }
  const q = new URLSearchParams({
    granularity: gran,
    price: req.price,
    from: new Date(req.from * 1000).toISOString(),
    to: new Date(req.to * 1000).toISOString(),
  });
  return `https://${oandaHost(req.practice)}/v3/accounts/${accountId}` +
    `/instruments/${oandaInstrument(req.symbol)}/candles?${q.toString()}`;
}

/** One candle as OANDA returns it. */
export interface OandaCandle {
  complete: boolean;
  volume: number;
  time: string;
  mid?: { o: string; h: string; l: string; c: string };
  bid?: { o: string; h: string; l: string; c: string };
  ask?: { o: string; h: string; l: string; c: string };
}

/**
 * Convert OANDA candles.
 *
 * Two decisions that matter:
 *  - `complete: false` is DROPPED. The forming bar changes on every request; using it would
 *    make a backtest depend on when it ran.
 *  - The price component is taken from whichever block is present, so a bid request does not
 *    silently produce zeros when the response carries `bid` rather than `mid`.
 */
export function parseOandaCandles(
  candles: readonly OandaCandle[],
  price: "bid" | "ask" | "mid",
): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    if (!c.complete) continue;
    const block = c[price] ?? c.mid ?? c.bid ?? c.ask;
    if (!block) continue;
    const o = Number(block.o);
    const h = Number(block.h);
    const l = Number(block.l);
    const cl = Number(block.c);
    if (![o, h, l, cl].every(Number.isFinite)) continue;
    const t = Date.parse(c.time);
    if (!Number.isFinite(t)) continue;
    out.push({
      time: Math.floor(t / 1000),
      open: o, high: h, low: l, close: cl,
      volume: Number.isFinite(c.volume) ? c.volume : 0,
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

/**
 * What the MT5 bridge must expose.
 *
 * Documented here because the bridge is a separate process the user runs, and the contract
 * between the two has to be written down somewhere both sides can see.
 *
 *   POST /login   {login, password, server}   -> {ok, symbols[]}
 *   GET  /candles ?symbol=&timeframe=&from=&to= -> {candles: [{time,open,high,low,close,volume}]}
 *
 * The bridge calls `mt5.copy_rates_range` and returns nothing else — no balance, no positions,
 * no order endpoints. That is deliberate: an app that cannot read an account cannot leak one.
 */
export interface BridgeCandleResponse {
  candles: Array<{
    time: number; open: number; high: number; low: number; close: number; volume: number;
  }>;
  /** the bridge's own error text, surfaced verbatim so a login failure is diagnosable */
  error?: string;
}

/**
 * Check a bridge's candle response before trusting it.
 *
 * A bridge that returns an empty array for a bad symbol looks identical to one that returns
 * empty for a weekend, so the error field is checked first and empty is reported honestly.
 */
export function validateBridgeResponse(res: unknown): { candles: Candle[]; error?: string } {
  if (typeof res !== "object" || res === null) {
    return { candles: [], error: "bridge returned a non-object" };
  }
  const r = res as Partial<BridgeCandleResponse>;
  if (typeof r.error === "string" && r.error.length > 0) {
    return { candles: [], error: r.error };
  }
  if (!Array.isArray(r.candles)) {
    return { candles: [], error: "bridge returned no candles array" };
  }
  const out: Candle[] = [];
  for (const c of r.candles) {
    if (typeof c !== "object" || c === null) continue;
    const { time, open, high, low, close, volume } = c as Record<string, unknown>;
    if (![time, open, high, low, close].every((v) => typeof v === "number" && Number.isFinite(v))) {
      continue;
    }
    out.push({
      time: time as number,
      open: open as number,
      high: high as number,
      low: low as number,
      close: close as number,
      volume: typeof volume === "number" ? volume : 0,
    });
  }
  return {
    candles: out.sort((a, b) => a.time - b.time),
    ...(out.length === 0 ? { error: "bridge returned no usable bars for that range" } : {}),
  };
}

/** Broker-picker text: why each adapter needs what it needs. */
export function describeTransport(t: MarketDataAdapter["transport"]): string {
  switch (t) {
    case "rest":
      return "talks to the broker's HTTPS API directly";
    case "terminal-bridge":
      return "needs the broker's own terminal running, plus a local bridge";
    case "open-api":
      return "uses the broker's open API with OAuth";
    default:
      return "unknown transport";
  }
}
