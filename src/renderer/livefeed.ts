/**
 * Renderer-side live feed.
 *
 * The provider needs a transport; in the renderer that transport is IPC to the
 * main process (because the CSP forbids direct sockets). This module builds the
 * provider + feed with an in-memory cache, which is exactly the same core code
 * the tests exercise -- only the transport differs.
 */
import { YahooProvider, YAHOO_SYMBOLS, type HttpResponse, type Transport } from "../core/providers/yahoo.js";
import { Feed, MemoryCache, type LoadResult } from "../core/feed.js";

export interface FxLabBridge {
  fetchJson(url: string, headers: Record<string, string>): Promise<{
    ok: boolean;
    status?: number;
    body?: unknown;
    retryAfterSeconds?: number;
    message?: string;
  }>;
}

function bridge(): FxLabBridge | null {
  const w = globalThis as unknown as { fxlab?: FxLabBridge };
  return w.fxlab ?? null;
}

/** Transport that routes through the main process. */
export const ipcTransport: Transport = async (url, headers) => {
  const api = bridge();
  if (!api) throw new Error("no bridge: running outside Electron");
  const r = await api.fetchJson(url, headers);
  if (!r.ok) throw new Error(r.message ?? "network error");
  const out: HttpResponse = {
    status: r.status ?? 0,
    body: r.body,
    ...(r.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: r.retryAfterSeconds }
      : {}),
  };
  return out;
};

export const symbols = YAHOO_SYMBOLS;

export function createFeed(): Feed {
  return new Feed(new YahooProvider(ipcTransport), new MemoryCache());
}

export type { LoadResult };
