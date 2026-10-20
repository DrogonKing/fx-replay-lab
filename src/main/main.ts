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
import { parseDrawings, parseJournal } from "../core/persist.js";
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

  // ---- persistence ----
  // Passed as unknown and validated inside db.ts (parseDrawings/parseJournal), so a
  // malformed payload from the renderer can never corrupt the store.
  ipcMain.handle("db:loadDrawings", (_e, workspace: string) => {
    if (typeof workspace !== "string" || workspace.length === 0) {
      return { raw: null, updatedAt: null };
    }
    // Returns the stored JSON string untouched: the renderer parses it once. Doing
    // it here too made every drawing look damaged (wire {t,p} vs drawing {time,price}).
    return db!.loadDrawings(workspace);
  });
  ipcMain.handle("db:saveDrawings", (_e, workspace: string, drawings: unknown[]) => {
    if (typeof workspace !== "string" || workspace.length === 0) {
      return { ok: false as const, message: "empty workspace key" };
    }
    if (!Array.isArray(drawings)) {
      return { ok: false as const, message: "drawings must be an array" };
    }
    // Round-trip through the parser before writing: this rejects anything the
    // reader would later refuse, so bad data never reaches the file at all.
    const checked = parseDrawings({ drawings });
    db!.saveDrawings(workspace, checked.value);
    return { ok: true as const, accepted: checked.value.length, rejected: checked.rejected };
  });

  ipcMain.handle("db:loadJournal", () => db!.loadJournal());
  ipcMain.handle("db:saveJournal", (_e, entries: unknown[]) => {
    if (!Array.isArray(entries)) {
      return { ok: false as const, message: "entries must be an array" };
    }
    const checked = parseJournal({ entries });
    db!.saveJournal(checked.value);
    return { ok: true as const, accepted: checked.value.length, rejected: checked.rejected };
  });

  ipcMain.handle("db:getSetting", (_e, key: string) => db!.getSetting(key));
  ipcMain.handle("db:setSetting", (_e, key: string, value: string) => {
    if (typeof key !== "string" || typeof value !== "string") {
      return { ok: false as const, message: "key and value must be strings" };
    }
    db!.setSetting(key, value);
    return { ok: true as const };
  });

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
