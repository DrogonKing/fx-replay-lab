/**
 * Preload bridge.
 *
 * Only these functions are exposed to the renderer; `contextBridge` makes them
 * the entire surface, so a compromised renderer (e.g. via a malicious CSV title)
 * cannot reach the filesystem or Node directly.
 */
import { contextBridge, ipcRenderer } from "electron";

export interface AppInfo {
  version: string;
  dataDir: string;
  offline: boolean;
}

export interface AccountRow {
  id: number;
  name: string;
  currency: string;
  startingBalance: number;
  leverage: number;
  mode: string;
}

export interface NetResponse {
  ok: boolean;
  status?: number;
  body?: unknown;
  retryAfterSeconds?: number;
  message?: string;
}

const api = {
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke("app:info"),
  listAccounts: (): Promise<AccountRow[]> => ipcRenderer.invoke("accounts:list"),
  /** Only allow-listed HTTPS hosts are reachable (see main/net.ts). */
  fetchJson: (url: string, headers: Record<string, string>): Promise<NetResponse> =>
    ipcRenderer.invoke("net:fetchJson", url, headers),

  // Persistence. Drawings are keyed by symbol+timeframe so a line drawn on M5
  // does not appear at a random place on D1.
  /** Returns the stored JSON string; the renderer parses it exactly once. */
  loadDrawings: (workspace: string): Promise<{
    raw: string | null; updatedAt: number | null;
  }> => ipcRenderer.invoke("db:loadDrawings", workspace),
  saveDrawings: (workspace: string, drawings: unknown[]): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("db:saveDrawings", workspace, drawings),

  loadJournal: (): Promise<{ value: unknown[]; rejected: string[] }> =>
    ipcRenderer.invoke("db:loadJournal"),
  saveJournal: (entries: unknown[]): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("db:saveJournal", entries),

  /** Download history from Dukascopy. Long-running; progress arrives via onDownloadProgress. */
  downloadHistory: (req: {
    symbol: string; from: number; to: number; workers: number;
  }): Promise<{
    ok: boolean;
    candles?: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
    progress?: unknown;
    message?: string;
  }> => ipcRenderer.invoke("data:downloadHistory", req),

  onDownloadProgress: (cb: (p: unknown) => void): void => {
    ipcRenderer.removeAllListeners("data:downloadProgress");
    ipcRenderer.on("data:downloadProgress", (_e, p) => cb(p));
  },

  /** Pick a data file; text for CSV, base64 for .bi5/.zip. */
  pickDataFile: (): Promise<{
    ok: boolean;
    name?: string;
    text?: string;
    candles?: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
    message?: string;
  }> => ipcRenderer.invoke("data:pickFile"),

  /** Probe a local MT5 bridge: health, symbols, and one real bar. Read-only. */
  /**
   * One press: start the bundled bridge, then log in. Returns which stage failed so the panel can
   * point at the right problem instead of a generic error.
   */
  bridgeConnect: (req: {
    login: string; password: string; server: string; url?: string;
  }): Promise<{
    ok: boolean; account?: string; symbols?: number;
    error?: string; stage?: "start" | "login" | "done"; steps?: string[];
  }> => ipcRenderer.invoke("broker:connect", req),

  bridgeAvailability: (): Promise<{
    available: boolean; reason: string | null; running: boolean; port: number; platform: string;
  }> => ipcRenderer.invoke("broker:bridgeAvailability"),

  bridgeStart: (): Promise<{ ok: boolean; error?: string; log?: string }> =>
    ipcRenderer.invoke("broker:bridgeStart"),

  bridgeStop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("broker:bridgeStop"),

  testBridge: (url: string): Promise<{
    ok: boolean;
    health?: { ok?: boolean; connected?: boolean; symbols?: number };
    symbols?: string[];
    bars?: number;
    firstOpen?: number;
    firstTime?: string;
    lastTime?: string;
    error?: string;
  }> => ipcRenderer.invoke("broker:testBridge", url),

  /** Log the MT5 terminal in through the bridge. The password is used once, never stored. */
  bridgeLogin: (req: {
    url: string; login: string; password: string; server: string;
  }): Promise<{ ok: boolean; account?: string; symbols?: number; error?: string }> =>
    ipcRenderer.invoke("broker:login", req),

  /** Bars from a local MT5 bridge (any MT4/MT5 broker, via its own terminal). */
  fetchBridgeCandles: (req: {
    url: string; symbol: string; timeframe: string; from: number; to: number;
  }): Promise<{
    ok: boolean;
    candles?: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
    error?: string;
  }> => ipcRenderer.invoke("broker:bridgeCandles", req),

  /** Bars from OANDA. The token is never stored or returned. */
  fetchOandaCandles: (req: {
    token: string; accountId: string; symbol: string; intervalMinutes: number;
    from: number; to: number; price: "bid" | "ask" | "mid"; practice: boolean;
  }): Promise<{
    ok: boolean;
    candles?: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
    error?: string;
  }> => ipcRenderer.invoke("broker:oandaCandles", req),

  /** Per-tool drawing style: raw JSON text, parsed by the renderer once. */
  loadToolConfigs: (): Promise<{ raw: string | null; updatedAt: number | null }> =>
    ipcRenderer.invoke("db:loadToolConfigs"),
  saveToolConfigs: (configs: unknown): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("db:saveToolConfigs", configs),

  /** User-defined symbols: raw JSON text, parsed by the renderer once. */
  loadSymbols: (): Promise<{ raw: string | null; updatedAt: number | null }> =>
    ipcRenderer.invoke("db:loadSymbols"),
  saveSymbols: (symbols: unknown): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("db:saveSymbols", symbols),

  /** Live trading session for a workspace: raw JSON text, parsed by the renderer once. */
  loadLiveSession: (workspace: string): Promise<{
    raw: string | null; updatedAt: number | null;
  }> => ipcRenderer.invoke("db:loadLiveSession", workspace),
  saveLiveSession: (workspace: string, state: unknown): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("db:saveLiveSession", workspace, state),
  clearLiveSession: (workspace: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("db:clearLiveSession", workspace),

  /** Persist an economic calendar snapshot (replaces the previous one). */
  saveNews: (events: unknown[]): Promise<number> =>
    ipcRenderer.invoke("db:saveNews", events),
  loadNews: (): Promise<Array<{
    time: number; currency: string; impact: string; title: string;
  }>> => ipcRenderer.invoke("db:loadNews"),

  getSetting: (key: string): Promise<string | null> =>
    ipcRenderer.invoke("db:getSetting", key),
  setSetting: (key: string, value: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("db:setSetting", key, value),

  // Strategy execution. Runs in main because the renderer CSP forbids eval.
  backtest: (req: unknown): Promise<unknown> =>
    ipcRenderer.invoke("strategy:backtest", req),
  optimize: (req: unknown, axes: unknown, maxRuns: number, metric: string): Promise<unknown> =>
    ipcRenderer.invoke("strategy:optimize", req, axes, maxRuns, metric),
  walkForward: (req: unknown, axes: unknown, trainBars: number, testBars: number): Promise<unknown> =>
    ipcRenderer.invoke("strategy:walkforward", req, axes, trainBars, testBars),
  monteCarlo: (pnls: number[], start: number): Promise<unknown> =>
    ipcRenderer.invoke("strategy:montecarlo", pnls, start),
  pine: (payload: unknown, source: string): Promise<unknown> =>
    ipcRenderer.invoke("strategy:pine", payload, source),
  pineParse: (source: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("strategy:pineParse", source),
};

contextBridge.exposeInMainWorld("fxlab", api);
export type FxLabApi = typeof api;
