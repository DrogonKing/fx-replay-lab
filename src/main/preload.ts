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
