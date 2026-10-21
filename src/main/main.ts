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
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import * as path from "node:path";
import { promises as fsp, mkdirSync } from "node:fs";
import { openDatabase, type Db, type NewsRow } from "./db.js";
import { parseDrawings, parseJournal } from "../core/persist.js";
import { fetchJson } from "./net.js";
import { decompressBi5, downloadRange, unzipCsv } from "./dukascopy-download.js";
import { parseDukascopyDay } from "../core/importer.js";
import { bridgeLogin, fetchBridgeCandles, fetchOandaCandles, testBridge } from "./broker-fetch.js";
import {
  handleBacktest, handleOptimize, handleWalkForward, handleMonteCarlo,
  handlePine, handlePineParse, type RunRequest,
} from "./strategy-host.js";
import type { GridAxis, RankMetric } from "../core/optimize.js";

const isDev = !app.isPackaged;
let db: Db | null = null;

function dataDir(): string {
  const dir = path.join(app.getPath("userData"), "fx-replay-lab");
  mkdirSync(dir, { recursive: true });
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

  // `--fx-test` (an explicit CLI switch, never a default) adds ?test=1 so the smoke
  // scripts can drive the engine directly. loadFile() takes a `query` object; putting
  // the query in the path does not work, which is why the first version of the hook
  // silently never installed.
  const testQuery = process.argv.includes("--fx-test")
    ? { test: "1" }
    : undefined;
  const indexPath = path.join(__dirname, "../renderer/index.html");

  if (isDev) {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) {
      const url = testQuery ? `${devUrl}?test=1` : devUrl;
      void win.loadURL(url);
      win.webContents.openDevTools({ mode: "detach" });
    } else {
      void win.loadFile(indexPath, testQuery ? { query: testQuery } : undefined);
    }
  } else {
    void win.loadFile(indexPath, testQuery ? { query: testQuery } : undefined);
  }
  return win;
}

app.whenReady().then(() => {
  db = openDatabase(path.join(dataDir(), "fx-replay-lab.db"));
  ipcMain.handle("db:loadSymbols", () =>
    db?.loadSymbols() ?? { raw: null, updatedAt: null });
  ipcMain.handle("db:saveSymbols", (_e, symbols: unknown) => {
    db?.saveSymbols(symbols);
    return { ok: true };
  });

  /**
   * Download history. Long-running by design (a 7-year pull is hours), so progress is pushed
   * to the renderer rather than polled, and the download is resumable from its own cache.
   */
  ipcMain.handle("data:downloadHistory", async (e, req: {
    symbol: string; from: number; to: number; workers: number;
  }) => {
    try {
      const dir = path.join(dataDir(), "history");
      const result = await downloadRange({
        symbol: req.symbol,
        from: req.from,
        to: req.to,
        dir,
        workers: Math.max(1, Math.min(4, req.workers)),
        onProgress: (p) => {
          if (!e.sender.isDestroyed()) e.sender.send("data:downloadProgress", p);
        },
      });
      return {
        ok: result.candles.length > 0,
        candles: result.candles,
        progress: result.progress,
        ...(result.candles.length === 0
          ? { message: "no bars returned for that range" }
          : {}),
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });

  /**
   * Pick and read a data file.
   *
   * Text for CSV, base64 for binary. The renderer decides what the bytes MEAN, because that
   * logic is pure and unit-tested; main only moves them.
   */
  ipcMain.handle("data:pickFile", async () => {
    const res = await dialog.showOpenDialog({
      title: "Import candles",
      properties: ["openFile"],
      filters: [
        { name: "All supported", extensions: ["csv", "txt", "bi5", "zip"] },
        { name: "CSV", extensions: ["csv", "txt"] },
        { name: "Dukascopy", extensions: ["bi5"] },
        { name: "Archive", extensions: ["zip"] },
      ],
    });
    if (res.canceled || res.filePaths.length === 0) return { ok: false };
    const file = res.filePaths[0]!;
    const name = path.basename(file);
    const buf = await fsp.readFile(file);
    // 60 MB is already several years of 1-minute CSV; refuse larger rather than hang
    if (buf.byteLength > 60 * 1024 * 1024) {
      return { ok: false, message: "file is larger than 60 MB" };
    }
    const lower = name.toLowerCase();

    // A Dukascopy .bi5 file stores offsets from midnight, so it needs its day. The download keeps
    // the server's folder layout (SYMBOL/YYYY/MM0/DD/BID_candles_min_1.bi5), so the date is in
    // the path — which is why this reads the path rather than asking the user.
    if (lower.endsWith(".bi5")) {
      const m = /([A-Za-z]{6})\/(\d{4})\/(\d{2})\/(\d{2})\//.exec(file.replace(/\\/g, "/"));
      if (!m) {
        return {
          ok: false,
          message:
            "This .bi5 has no date in its path. Dukascopy keeps " +
            "SYMBOL/YYYY/MM/DD/ in the folder — import the folder instead, or the day " +
            "cannot be reconstructed because the file stores only offsets from midnight.",
        };
      }
      const [, sym, ys, ms, ds] = m;
      try {
        const raw = decompressBi5(buf);
        // month in the path is ZERO-indexed; parseDukascopyDay takes 1-indexed
        const res = parseDukascopyDay(raw, sym!.toUpperCase(), Number(ys), Number(ms) + 1, Number(ds));
        return { ok: true, name, kind: "candles", candles: res.candles };
      } catch (err) {
        return { ok: false, message: `could not decode ${name}: ${(err as Error).message}` };
      }
    }

    if (lower.endsWith(".zip")) {
      const entries = unzipCsv(buf);
      if (entries.length === 0) {
        return { ok: false, message: "no CSV inside that archive" };
      }
      // concatenate: a HistData monthly ZIP holds one file
      return { ok: true, name, text: entries.join("\n") };
    }

    return { ok: true, name, text: buf.toString("utf8") };
  });

  /** Probe a local MT5 bridge. Read-only: health, symbols, and one real bar. */
  ipcMain.handle("broker:testBridge", async (_e, url: string) => {
    try {
      return await testBridge(String(url));
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /**
   * Log the MT5 terminal in through the bridge.
   *
   * The password crosses this IPC boundary and is used once, in memory. It is never written to
   * the database and never logged.
   */
  ipcMain.handle("broker:login", async (_e, req: {
    url: string; login: string; password: string; server: string;
  }) => {
    try {
      return await bridgeLogin(req);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /** Bars from a local MT5 bridge. Any broker's terminal works, because the bridge drives it. */
  ipcMain.handle("broker:bridgeCandles", async (_e, req: {
    url: string; symbol: string; timeframe: string; from: number; to: number;
  }) => {
    try {
      return await fetchBridgeCandles(req);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /**
   * Bars from OANDA.
   *
   * The token arrives in the IPC payload and is used once, in memory. It is never written to
   * the database, never logged, and never returned — only candles or an error come back.
   */
  ipcMain.handle("broker:oandaCandles", async (_e, req: {
    token: string; accountId: string; symbol: string; intervalMinutes: number;
    from: number; to: number; price: "bid" | "ask" | "mid"; practice: boolean;
  }) => {
    try {
      return await fetchOandaCandles(req);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle("db:loadToolConfigs", () =>
    db?.loadToolConfigs() ?? { raw: null, updatedAt: null });
  ipcMain.handle("db:saveToolConfigs", (_e, configs: unknown) => {
    db?.saveToolConfigs(configs);
    return { ok: true };
  });

  ipcMain.handle("db:loadLiveSession", (_e, workspace: string) =>
    db?.loadLiveSession(workspace) ?? { raw: null, updatedAt: null });
  ipcMain.handle("db:saveLiveSession", (_e, workspace: string, state: unknown) => {
    db?.saveLiveSession(workspace, state);
    return { ok: true };
  });
  ipcMain.handle("db:clearLiveSession", (_e, workspace: string) => {
    db?.clearLiveSession(workspace);
    return { ok: true };
  });

  ipcMain.handle("db:saveNews", (_e, events: unknown) => {
    // `db` is assigned in whenReady; the handler cannot fire before the window exists.
    const store = db;
    if (!store) return 0;
    const list = (Array.isArray(events) ? events : []) as NewsRow[];
    return store.saveNews(list);
  });
  ipcMain.handle("db:loadNews", () => db?.loadNews() ?? []);

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
