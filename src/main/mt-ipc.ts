/**
 * MT data service (main process): live polling, chunked history download,
 * and the offline catalog over the candle store.
 *
 * Split from broker-fetch.ts because that file answers "can I talk to a
 * bridge at all" while this one owns the v2 app lifecycle: connect once,
 * then poll /latest ticks and walk /download chunks into SQLite. The
 * transport rules stay in net.ts + broker-fetch.ts; this layer never
 * touches a URL that has not been through the same allowlist.
 */
import { bridgeOrigin, fetchBridgeCandles } from "./broker-fetch.js";
import { bridgeUrlAllowed } from "./net.js";
import { bridgePort } from "./bridge-process.js";
import type { Candle } from "../core/types.js";
import type { CandleStore } from "./mt-store.js";

export const BRIDGE_URL = `http://127.0.0.1:${bridgePort()}`;

/** Minutes per timeframe the bridge serves. Must stay in sync with mt5-bridge.py. */
export const TF_MINUTES: Record<string, number> = {
  M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440,
};

export interface MtHealth {
  ok?: boolean;
  connected?: boolean;
  account?: string;
  server?: string;
  company?: string;
  symbols?: number;
  terminalPid?: number | null;
  startedByUs?: boolean;
  hidden?: boolean;
  serverOffsetSeconds?: number | null;
}

/** Live /health. Being ALIVE is ok:true; connected says whether a terminal session exists. */
export async function mtStatus(url = BRIDGE_URL): Promise<MtHealth | { error: string }> {
  const u = `${bridgeOrigin(url)}/health`;
  if (!bridgeUrlAllowed(u)) return { error: "refused: bridge URL not allowed" };
  try {
    const res = await fetch(u, { signal: AbortSignal.timeout(2500) });
    return (await res.json()) as MtHealth;
  } catch (e) {
    return { error: `bridge not reachable: ${(e as Error).message}` };
  }
}

/**
 * Recent bars for the live chart: enough to cover `count` bars ending now.
 *
 * One request per poll. The renderer merges the result into the forming bar
 * via the same mergeSeries path the Yahoo feed uses, so MT and Yahoo charts
 * behave identically as the clock advances.
 */
export async function mtLatest(req: {
  url?: string; symbol: string; timeframe: string; count: number;
}): Promise<{ ok: boolean; candles?: Candle[]; error?: string }> {
  const tfMin = TF_MINUTES[req.timeframe];
  if (!tfMin) return { ok: false, error: `unsupported timeframe ${req.timeframe}` };
  const now = Math.floor(Date.now() / 1000);
  // 2x margin: weekend gaps and a slow broker clock must not starve the poll
  const from = now - Math.max(req.count, 10) * tfMin * 60 * 2;
  return fetchBridgeCandles({
    url: req.url ?? BRIDGE_URL,
    symbol: req.symbol,
    timeframe: req.timeframe,
    from,
    to: now + 60,
  });
}

export interface DownloadState {
  chunksTotal: number;
  chunksDone: number;
  bars: number;
  failed: number;
  failures: string[];
}

/**
 * Walk a range from the logged-in MT account into the candle store, chunk by chunk.
 *
 * Chunks are sized in BARS (20,000), not days: the terminal silently truncates a
 * response at its "Max bars in chart" setting, so a request larger than that
 * returns fewer bars than the range covers with no error — the audit's finding.
 * 20k stays under the smallest common setting while keeping a year of M1 to
 * ~19 requests. A chunk is only marked done when its request returned cleanly;
 * an interrupted download therefore resumes at the first incomplete chunk.
 */
const BARS_PER_CHUNK = 20_000;

let downloadCancelled = false;
export function cancelMtDownload(): void {
  downloadCancelled = true;
}

export async function mtDownload(req: {
  url?: string;
  symbol: string;
  timeframe: string;
  from: number; // epoch seconds, inclusive
  to: number; // epoch seconds, exclusive
  source: string; // store tag, e.g. "mt5:ICMarkets-Demo"
  store: CandleStore;
  onProgress?: (p: DownloadState) => void;
}): Promise<{ ok: boolean; state: DownloadState; error?: string }> {
  const tfMin = TF_MINUTES[req.timeframe];
  if (!tfMin) {
    return { ok: false, state: emptyState(), error: `unsupported timeframe ${req.timeframe}` };
  }

  const chunkSec = BARS_PER_CHUNK * tfMin * 60;
  const starts: number[] = [];
  for (let t = req.from; t < req.to; t += chunkSec) starts.push(t);

  const done = new Set(req.store.doneChunks(req.symbol, req.timeframe));
  const state: DownloadState = {
    ...emptyState(),
    chunksTotal: starts.length,
    chunksDone: done.size,
  };

  downloadCancelled = false;
  for (const start of starts) {
    if (downloadCancelled) {
      return { ok: false, state, error: "cancelled" };
    }
    if (done.has(start)) {
      // already stored by a previous run — count it, skip the request
      state.chunksDone++;
      req.onProgress?.({ ...state });
      continue;
    }

    const end = Math.min(start + chunkSec, req.to);
    const res = await fetchBridgeCandles({
      url: req.url ?? BRIDGE_URL,
      symbol: req.symbol,
      timeframe: req.timeframe,
      from: start,
      to: end - 1,
    });

    if (!res.ok) {
      // recorded, not thrown: one dead chunk (a holiday month, a server hiccup)
      // must not discard the eighteen that succeeded before it
      state.failed++;
      state.failures.push(`${new Date(start * 1000).toISOString().slice(0, 10)}: ${res.error}`);
      req.onProgress?.({ ...state });
      continue;
    }

    const bars = res.candles ?? [];
    req.store.upsert(req.symbol, req.timeframe, req.source, bars);
    req.store.markChunk(req.symbol, req.timeframe, start, bars.length, "done");
    state.bars += bars.length;
    state.chunksDone++;
    req.onProgress?.({ ...state });
  }

  return { ok: state.failed === 0, state };
}

function emptyState(): DownloadState {
  return { chunksTotal: 0, chunksDone: 0, bars: 0, failed: 0, failures: [] };
}

/**
 * Ask the bridge to release the terminal cleanly, then let the caller kill it.
 *
 * mt5.shutdown() closes a terminal the bridge itself launched and leaves a
 * user-started one running, which is exactly the ownership rule we want:
 * never kill a process we did not start.
 */
export async function bridgeShutdown(url = BRIDGE_URL): Promise<boolean> {
  const u = `${bridgeOrigin(url)}/shutdown`;
  if (!bridgeUrlAllowed(u)) return false;
  try {
    const res = await fetch(u, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
