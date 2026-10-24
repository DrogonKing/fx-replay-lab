/**
 * Broker data fetchers, in the main process.
 *
 * Two very different transports live here behind one idea: give me candles.
 *
 *  - The MT5 bridge is reachable only on loopback over plain HTTP, so it needs its own narrow
 *    permission rule rather than the general HTTPS allowlist.
 *  - OANDA is a normal HTTPS API, but it carries a token, so the token never reaches the
 *    renderer's network layer and never appears in an error string.
 *
 * Both return the same shape, because the panel should not care which one answered.
 */
import { bridgeUrlAllowed } from "./net.js";
import { oandaCandlesUrl, parseOandaCandles, type OandaCandle } from "../core/brokers.js";
import type { Candle } from "../core/types.js";

export interface BrokerCandleResult {
  ok: boolean;
  candles?: Candle[];
  error?: string;
}

/**
 * Strip any endpoint path from a bridge URL, leaving the origin.
 *
 * A user who copies "http://127.0.0.1:8765/health" out of a curl example, or pastes
 * "http://127.0.0.1:8765/candles?symbol=...", means "my bridge is here" — not "probe this exact
 * path". Appending "/health" to that produced "/health/health", which the allowlist refuses with
 * "not a local bridge address", blaming the host for a path problem.
 */
export function bridgeOrigin(url: string): string {
  try {
    const u = new URL(url.trim());
    return `${u.protocol}//${u.host}`;
  } catch {
    // let the caller's validation produce the error message, with its own wording
    return url.trim().replace(/\/+$/, "");
  }
}

/** Timeout for a bridge probe. A local process answers in milliseconds or not at all. */
const PROBE_TIMEOUT_MS = 4000;
/** A candle request can be slow the first time a broker downloads history. */
const CANDLE_TIMEOUT_MS = 60_000;

/**
 * Probe a bridge and, in the same call, prove it can actually serve bars.
 *
 * A `/health` check alone is not enough: a bridge attached to a terminal with no symbols
 * answers health with `connected: true` and then fails every candle request. So this asks for
 * one real bar too, and reports which step failed.
 */
export async function testBridge(url: string): Promise<{
  ok: boolean;
  health?: { ok?: boolean; connected?: boolean; symbols?: number };
  symbols?: string[];
  bars?: number;
  firstOpen?: number;
  firstTime?: string;
  lastTime?: string;
  error?: string;
}> {
  const base = bridgeOrigin(url);
  const healthUrl = `${base}/health`;
  if (!bridgeUrlAllowed(healthUrl)) {
    return {
      ok: false,
      error:
        "that URL is not a local bridge address — the bridge must be " +
        "http://127.0.0.1:<port> or http://localhost:<port>",
    };
  }

  let health: { ok?: boolean; connected?: boolean; symbols?: number };
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) {
      return { ok: false, error: `bridge answered HTTP ${res.status} on /health` };
    }
    health = (await res.json()) as typeof health;
  } catch (e) {
    return { ok: false, error: explainFetchFailure(e, healthUrl) };
  }

  if (health.connected !== true) {
    return {
      ok: false,
      health,
      error:
        "the bridge is running but no terminal is attached — open MetaTrader, " +
        "log in to the account, then probe again",
    };
  }

  // symbols: needed so the panel can offer the broker's own naming (suffixes are the single
  // most common reason a bridge "does not work")
  let symbols: string[] = [];
  try {
    const res = await fetch(`${base}/symbols`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 3),
    });
    if (res.ok) {
      const d = (await res.json()) as { symbols?: string[] };
      symbols = Array.isArray(d.symbols) ? d.symbols : [];
    }
  } catch {
    // a missing symbol list is not fatal; the probe continues to the bar test
  }

  // the decisive test: one real bar. 30 days back, so the range is inside any broker's history.
  const to = Math.floor(Date.now() / 1000);
  const from = to - 30 * 86400;
  const candidate =
    symbols.find((s) => /^EURUSD$/i.test(s)) ??
    symbols.find((s) => /^EURUSD/i.test(s)) ??
    "EURUSD";

  try {
    const q = new URLSearchParams({
      symbol: candidate, timeframe: "M1", from: String(from), to: String(to),
    });
    const cUrl = `${base}/candles?${q.toString()}`;
    if (!bridgeUrlAllowed(cUrl)) {
      return { ok: false, health, symbols, error: "refused: bridge URL not allowed" };
    }
    const res = await fetch(cUrl, { signal: AbortSignal.timeout(CANDLE_TIMEOUT_MS) });
    const d = (await res.json()) as {
      candles?: Array<{ time: number; open: number }>;
      error?: string;
    };
    if (d.error) {
      return { ok: false, health, symbols, error: d.error };
    }
    const bars = d.candles ?? [];
    if (bars.length === 0) {
      return {
        ok: false, health, symbols,
        error: `the bridge answered but returned 0 bars for ${candidate} M1`,
      };
    }
    return {
      ok: true, health, symbols,
      bars: bars.length,
      firstOpen: bars[0]!.open,
      firstTime: new Date(bars[0]!.time * 1000).toISOString(),
      lastTime: new Date(bars[bars.length - 1]!.time * 1000).toISOString(),
    };
  } catch (e) {
    return { ok: false, health, symbols, error: `candle request failed: ${(e as Error).message}` };
  }
}

/**
 * Log the MT5 terminal in through the bridge.
 *
 * This is the only POST the bridge accepts, and the only place a password moves. It is sent to
 * loopback over plain HTTP — which is why the bridge binds to 127.0.0.1 and nothing else — and it
 * is NOT echoed into any error string, because an error message is the most common way a secret
 * ends up in a log.
 */
/** A cold-start login can take ~2.5 minutes: the bridge launches the terminal, waits for
 *  its IPC to come up (first server connect + cache rebuild), then logs in. 60 s aborted
 *  real logins mid-flight and reported them as network errors. */
const LOGIN_TIMEOUT_MS = 180_000;

export async function bridgeLogin(req: {
  url: string; login: string; password: string; server: string;
}): Promise<{ ok: boolean; account?: string; symbols?: number; error?: string }> {
  const scrub = (s: string): string =>
    req.password.length > 0 ? s.split(req.password).join("[REDACTED]") : s;

  const url = `${bridgeOrigin(req.url)}/login`;
  if (!bridgeUrlAllowed(url)) {
    return {
      ok: false,
      error:
        "that URL is not a local bridge address — the bridge must be " +
        "http://127.0.0.1:<port> or http://localhost:<port>",
    };
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: req.login, password: req.password, server: req.server }),
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    });
    const body = (await res.json()) as { ok?: boolean; account?: string; symbols?: number; error?: string };
    if (body.ok === true) {
      return { ok: true, account: body.account, symbols: body.symbols };
    }
    return { ok: false, error: scrub(body.error ?? `login refused with HTTP ${res.status}`) };
  } catch (e) {
    return { ok: false, error: scrub(explainFetchFailure(e, url)) };
  }
}

/**
 * Turn a fetch failure into something a user can act on.
 *
 * Node reports every connection problem as "fetch failed" and hides the reason in `cause`. That
 * string is what a user saw when they pressed Log in with no bridge running, and it reads like the
 * button is broken rather than like a prerequisite is missing. The cause codes are stable
 * (`ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `UND_ERR_CONNECT_TIMEOUT`), so they can be mapped to a
 * sentence that names the next action.
 */
export function explainFetchFailure(e: unknown, url: string): string {
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code ?? "";
  const base = bridgeOrigin(url);
  if (code === "ECONNREFUSED") {
    return `nothing is listening at ${base} — the bridge is not running. Start it with: ` +
      `python bridge/mt5-bridge.py (on the Windows machine where MetaTrader is installed), ` +
      `then press Log in again.`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `${base} does not resolve — check the address; the bridge runs on 127.0.0.1 or localhost.`;
  }
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") {
    return `${base} did not answer in time. The bridge may be starting; try again in a moment.`;
  }
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") {
    return `the connection to ${base} was closed mid-request. Check the bridge's console for a traceback.`;
  }
  const detail = cause?.code ?? cause?.message ?? (e as Error).message;
  return `could not reach ${base} (${detail}). Is the bridge running on that port?`;
}

/** Bars from a bridge. The bridge's own error text is passed through unchanged. */
export async function fetchBridgeCandles(req: {
  url: string; symbol: string; timeframe: string; from: number; to: number;
}): Promise<BrokerCandleResult> {
  const q = new URLSearchParams({
    symbol: req.symbol,
    timeframe: req.timeframe,
    from: String(req.from),
    to: String(req.to),
  });
  const url = `${bridgeOrigin(req.url)}/candles?${q.toString()}`;
  if (!bridgeUrlAllowed(url)) {
    return { ok: false, error: "refused: bridge URL not allowed" };
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(CANDLE_TIMEOUT_MS) });
    const d = (await res.json()) as {
      candles?: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
      error?: string;
    };
    if (d.error) return { ok: false, error: d.error };
    const candles = (d.candles ?? []).filter((c) =>
      [c.time, c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v)),
    );
    if (candles.length === 0) {
      return { ok: false, error: `the bridge returned no usable bars for ${req.symbol} ${req.timeframe}` };
    }
    return { ok: true, candles };
  } catch (e) {
    return { ok: false, error: `bridge request failed: ${(e as Error).message}` };
  }
}

/**
 * Bars from OANDA.
 *
 * The token is used here and nowhere else. It is deliberately absent from every return value,
 * and the error strings are scrubbed before leaving this function — an error message is the
 * most common way a secret leaks into a log.
 */
export async function fetchOandaCandles(req: {
  token: string;
  accountId: string;
  symbol: string;
  intervalMinutes: number;
  from: number;
  to: number;
  price: "bid" | "ask" | "mid";
  practice: boolean;
}): Promise<BrokerCandleResult> {
  const scrub = (s: string): string =>
    req.token.length > 0 ? s.split(req.token).join("[REDACTED]") : s;

  let url: string;
  try {
    url = oandaCandlesUrl(req.accountId, {
      symbol: req.symbol,
      intervalMinutes: req.intervalMinutes,
      from: req.from,
      to: req.to,
      price: req.price,
      practice: req.practice,
    });
  } catch (e) {
    return { ok: false, error: scrub((e as Error).message) };
  }

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${req.token}`,
        "Content-Type": "application/json",
        "Accept-Datetime-Format": "RFC3339",
      },
      signal: AbortSignal.timeout(CANDLE_TIMEOUT_MS),
    });

    if (res.status === 401) {
      return {
        ok: false,
        error:
          "OANDA rejected the token (401). Check it was copied whole, and that the practice " +
          "and live hosts match the token's account.",
      };
    }
    if (res.status === 404) {
      return {
        ok: false,
        error:
          `OANDA has no instrument "${req.symbol}" (404). OANDA uses EUR_USD with an ` +
          "underscore, not EURUSD.",
      };
    }
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: scrub(`OANDA answered ${res.status}: ${text.slice(0, 200)}`) };
    }

    const body = (await res.json()) as { candles?: OandaCandle[] };
    const candles = parseOandaCandles(body.candles ?? [], req.price);
    if (candles.length === 0) {
      return {
        ok: false,
        error:
          "OANDA returned no complete candles for that range. Very old or future ranges come " +
          "back empty, and the forming bar is dropped by design.",
      };
    }
    return { ok: true, candles };
  } catch (e) {
    return { ok: false, error: scrub(`OANDA request failed: ${(e as Error).message}`) };
  }
}
