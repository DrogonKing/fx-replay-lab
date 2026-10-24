/**
 * Candle history store (better-sqlite3), the v2 home for downloaded bars.
 *
 * Separate database file from the main db on purpose: settings/journal stay
 * small, while candle bulk-inserts and range reads get their own WAL file
 * that can be deleted or compacted without touching anything else.
 *
 * Resumable downloads: the downloader walks fixed time chunks (a month for
 * M1, proportionally larger for higher timeframes). A chunk is only skipped
 * when a `done` row exists in download_chunks — an interrupted run leaves
 * no `done` row and the chunk is retried, mirroring the Dukascopy per-day
 * cache rule ("a failed day is not cached").
 *
 * Times are TRUE UTC epoch seconds. MT5 serves bars in the broker's server
 * timezone; the bridge normalises before they ever get here, so this store
 * never has to guess.
 */
import Database from "better-sqlite3";
import type { Candle } from "../core/types.js";

export interface ChunkRow {
  symbol: string;
  tf: string;
  chunk: number; // chunk start, epoch seconds
  bars: number;
  status: "done" | "empty";
  updated_at: number;
}

export interface Coverage {
  symbol: string;
  tf: string;
  source: string;
  count: number;
  from: number;
  to: number;
}

export interface CandleStore {
  /** Insert bars, replacing any same-timestamp bar (broker corrections win). Returns rows written. */
  upsert(symbol: string, tf: string, source: string, candles: readonly Candle[]): number;
  /** Bars in [from, to] ascending; from/to optional. */
  load(symbol: string, tf: string, from?: number, to?: number): Candle[];
  /** Coverage per (symbol, tf) for the catalog UI and the downloader resume check. */
  coverage(): Coverage[];
  markChunk(symbol: string, tf: string, chunk: number, bars: number, status: "done" | "empty"): void;
  /** Chunk starts already marked done, so a resumed download skips them. */
  doneChunks(symbol: string, tf: string): number[];
  /** Remove a chunk mark so the downloader retries it. */
  forgetChunks(symbol: string, tf: string): void;
  delete(symbol: string, tf: string): void;
  close(): void;
  raw: Database.Database;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS candles (
  symbol TEXT    NOT NULL,
  tf     TEXT    NOT NULL,
  time   INTEGER NOT NULL,
  open   REAL    NOT NULL,
  high   REAL    NOT NULL,
  low    REAL    NOT NULL,
  close  REAL    NOT NULL,
  volume REAL    NOT NULL DEFAULT 0,
  source TEXT    NOT NULL,
  PRIMARY KEY (symbol, tf, time)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS download_chunks (
  symbol     TEXT    NOT NULL,
  tf         TEXT    NOT NULL,
  chunk      INTEGER NOT NULL,
  bars       INTEGER NOT NULL,
  status     TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (symbol, tf, chunk)
);
`;

export function openCandleStore(file: string): CandleStore {
  const raw = new Database(file);
  raw.pragma("journal_mode = WAL");
  raw.exec(SCHEMA);

  const insertStmt = raw.prepare(
    `INSERT INTO candles (symbol, tf, time, open, high, low, close, volume, source)
     VALUES (@symbol, @tf, @time, @open, @high, @low, @close, @volume, @source)
     ON CONFLICT(symbol, tf, time) DO UPDATE SET
       open = excluded.open, high = excluded.high, low = excluded.low,
       close = excluded.close, volume = excluded.volume, source = excluded.source`,
  );

  const loadStmt = raw.prepare(
    `SELECT time, open, high, low, close, volume FROM candles
      WHERE symbol = ? AND tf = ? AND time >= ? AND time <= ?
      ORDER BY time`,
  );

  const coverageStmt = raw.prepare(
    `SELECT symbol, tf, source, COUNT(*) AS count, MIN(time) AS from_, MAX(time) AS to_
       FROM candles GROUP BY symbol, tf, source ORDER BY symbol, tf`,
  );

  const upsertTx = raw.transaction((symbol: string, tf: string, source: string, candles: readonly Candle[]) => {
    for (const c of candles) {
      insertStmt.run({
        symbol, tf, source,
        time: c.time, open: c.open, high: c.high, low: c.low,
        close: c.close, volume: c.volume ?? 0,
      });
    }
    return candles.length;
  });

  return {
    raw,

    upsert: (symbol, tf, source, candles) => upsertTx(symbol, tf, source, candles) as number,

    load: (symbol, tf, from = 0, to = Number.MAX_SAFE_INTEGER) =>
      loadStmt.all(symbol, tf, from, to) as Candle[],

    coverage: () =>
      (coverageStmt.all() as Array<Omit<Coverage, "from" | "to"> & { from_: number; to: number }>)
        .map((r) => ({ symbol: r.symbol, tf: r.tf, source: r.source, count: r.count, from: r.from_, to: r.to })),

    markChunk: (symbol, tf, chunk, bars, status) => {
      raw.prepare(
        `INSERT INTO download_chunks (symbol, tf, chunk, bars, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol, tf, chunk) DO UPDATE SET
           bars = excluded.bars, status = excluded.status, updated_at = excluded.updated_at`,
      ).run(symbol, tf, chunk, bars, status, Date.now());
    },

    doneChunks: (symbol, tf) =>
      (raw.prepare(
        "SELECT chunk FROM download_chunks WHERE symbol = ? AND tf = ? AND status = 'done'",
      ).all(symbol, tf) as Array<{ chunk: number }>).map((r) => r.chunk),

    forgetChunks: (symbol, tf) => {
      raw.prepare("DELETE FROM download_chunks WHERE symbol = ? AND tf = ?").run(symbol, tf);
    },

    delete: (symbol, tf) => {
      const tx = raw.transaction(() => {
        raw.prepare("DELETE FROM candles WHERE symbol = ? AND tf = ?").run(symbol, tf);
        raw.prepare("DELETE FROM download_chunks WHERE symbol = ? AND tf = ?").run(symbol, tf);
      });
      tx();
    },

    close: () => raw.close(),
  };
}
