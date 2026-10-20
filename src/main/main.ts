/**
 * Electron main process.
 *
 * Responsibilities kept deliberately thin: window lifecycle, the SQLite handle,
 * and IPC. All trading logic lives in src/core so it stays testable without
 * Electron.
 *
 * Security posture (matters for an app that imports untrusted CSV files):
 *   - contextIsolation on, nodeIntegration off, sandbox on;
 *   - the renderer talks only through the preload bridge;
 *   - navigation and new windows are blocked, since the app is offline by design.
 */
import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import { openDatabase, type Db } from "./db.js";
import { fetchJson } from "./net.js";
import {
  handleBacktest, handleOptimize, handleWalkForward, handleMonteCarlo,
  handlePine, handlePineParse, type RunRequest,
} from "./strategy-host.js";
import type { GridAxis, RankMetric } from "../core/optimize.js";

const isDev = !app.isPackaged;
let db: Db | null = null;

function dataDir(): string {
  const dir = path.join(app.getPath("userData"), "fx-replay-lab");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: "#131722",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The app is offline; no remote content is ever loaded.
      webSecurity: true,
    },
  });

  win.once("ready-to-show", () => win.show());

  // Block navigation and popups: nothing should leave the local bundle.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Open real links in the OS browser, never inside the app shell.
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) {
      void win.loadURL(devUrl);
      win.webContents.openDevTools({ mode: "detach" });
    } else {
      void win.loadFile(path.join(__dirname, "../renderer/index.html"));
    }
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  return win;
}

app.whenReady().then(() => {
  db = openDatabase(path.join(dataDir(), "fx-replay-lab.db"));
  ipcMain.handle("app:info", () => ({
    version: app.getVersion(),
    dataDir: dataDir(),
    offline: true,
  }));
  ipcMain.handle("accounts:list", () => db!.listAccounts());

  // Strategy execution lives here because the renderer CSP blocks `new Function`
  // (no 'unsafe-eval'). Results cross IPC as plain data.
  ipcMain.handle("strategy:backtest", (_e, req: RunRequest) => handleBacktest(req));
  ipcMain.handle(
    "strategy:optimize",
    (_e, req: RunRequest, axes: GridAxis[], maxRuns: number, metric: RankMetric) =>
      handleOptimize(req, axes, maxRuns, metric),
  );
  ipcMain.handle(
    "strategy:walkforward",
    (_e, req: RunRequest, axes: GridAxis[], trainBars: number, testBars: number) =>
      handleWalkForward(req, axes, trainBars, testBars),
  );
  ipcMain.handle("strategy:montecarlo", (_e, pnls: number[], start: number) =>
    handleMonteCarlo(pnls, start),
  );
  ipcMain.handle("strategy:pine", (_e, payload, source: string) =>
    handlePine(payload, source),
  );
  ipcMain.handle("strategy:pineParse", (_e, source: string) => handlePineParse(source));

  // Live data goes through the main process: the renderer's CSP forbids sockets.
  ipcMain.handle(
    "net:fetchJson",
    async (_e, url: string, headers: Record<string, string>) => {
      try {
        return { ok: true as const, ...(await fetchJson(url, headers)) };
      } catch (e) {
        return { ok: false as const, message: (e as Error).message };
      }
    },
  );

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  db?.close();
  db = null;
  if (process.platform !== "darwin") app.quit();
});
