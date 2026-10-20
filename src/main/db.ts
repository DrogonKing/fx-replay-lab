/**
 * SQLite persistence (better-sqlite3).
 *
 * Synchronous on purpose: the main process is not the UI thread, and every query
 * here is a handful of rows. The heavy data (candles) is NOT stored here -- it
 * lives in the columnar store -- so this database stays small and fast.
 *
 * Schema is created with IF NOT EXISTS and a user_version bump so an existing
 * user's file upgrades instead of being wiped.
 *
 * Drawings and journal entries are stored as JSON blobs keyed by workspace. Row
 * per shape would mean a migration every time a tool gains a field, and the whole
 * set is read at once anyway; the trade-off is documented in ADR-010.
 */
import Database from "better-sqlite3";
import {
  parseDrawings, parseJournal, serialiseDrawings, serialiseJournal,
  type JournalEntry,
} from "../core/persist.js";
import type { Drawing } from "../core/drawings.js";

export interface AccountRow {
  id: number;
  name: string;
  currency: string;
  startingBalance: number;
  leverage: number;
  mode: string;
}

export interface LoadResult<T> {
  value: T;
  /** rows that were dropped because they were malformed */
  rejected: string[];
  /** when the data was last written, epoch ms, or null if never */
  updatedAt: number | null;
}

/**
 * Raw payload as stored.
 *
 * Returned as the untouched JSON string rather than a decoded value, so exactly ONE
 * layer validates it (the renderer, via parseDrawings). Decoding here AND there
 * caused every drawing to be rejected as damaged: this function emitted
 * `{time, price}` points while the parser expected the wire form `{t, p}`.
 */
export interface RawLoadResult {
  raw: string | null;
  updatedAt: number | null;
}

export interface NewsRow {
  time: number;
  currency: string;
  impact: string;
  title: string;
}

export interface Db {
  listAccounts(): AccountRow[];
  createAccount(a: Omit<AccountRow, "id">): number;

  // drawings, per workspace (raw JSON, parsed by the caller exactly once)
  loadDrawings(workspace: string): RawLoadResult;
  saveDrawings(workspace: string, drawings: readonly Drawing[]): void;

  // journal entries, global (they carry their own symbol)
  loadJournal(): LoadResult<JournalEntry[]>;
  saveJournal(entries: readonly JournalEntry[]): void;

  // economic calendar: one snapshot, replaced on every import
  saveNews(events: readonly NewsRow[]): number;
  loadNews(): NewsRow[];

  // plain settings (last symbol, timeframe, offline flag, ...)
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;

  close(): void;
  raw: Database.Database;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  currency          TEXT    NOT NULL DEFAULT 'USD',
  starting_balance  REAL    NOT NULL,
  leverage          INTEGER NOT NULL DEFAULT 100,
  mode              TEXT    NOT NULL DEFAULT 'hedging'
);

CREATE TABLE IF NOT EXISTS trades (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  symbol        TEXT    NOT NULL,
  side          TEXT    NOT NULL,
  lots          REAL    NOT NULL,
  entry_time    INTEGER NOT NULL,
  entry_price   REAL    NOT NULL,
  exit_time     INTEGER NOT NULL,
  exit_price    REAL    NOT NULL,
  sl            REAL,
  tp            REAL,
  reason        TEXT    NOT NULL,
  pnl           REAL    NOT NULL,
  commission    REAL    NOT NULL DEFAULT 0,
  swap          REAL    NOT NULL DEFAULT 0,
  notes         TEXT    NOT NULL DEFAULT '',
  tags          TEXT    NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_trades_account ON trades(account_id, exit_time);

CREATE TABLE IF NOT EXISTS news (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  time      INTEGER NOT NULL,
  currency  TEXT    NOT NULL,
  impact    TEXT    NOT NULL,
  title     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_news_time ON news(time);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/**
 * Tables added after v1.
 *
 * Separate from SCHEMA and run with IF NOT EXISTS so a database created by an
 * earlier build gains them without a destructive migration: `drawing_sets` and
 * `journal` are new in v2.
 */
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS drawing_sets (
  workspace  TEXT PRIMARY KEY,
  payload    TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS journal (
  id   TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  exit_time INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journal_exit ON journal(exit_time);
`;

export function openDatabase(file: string): Db {
  const raw = new Database(file);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.exec(SCHEMA);
  raw.exec(SCHEMA_V2);

  const version = raw.pragma("user_version", { simple: true }) as number;
  if (version < 2) raw.pragma("user_version = 2");

  const listStmt = raw.prepare(
    `SELECT id, name, currency, starting_balance AS startingBalance,
            leverage, mode
       FROM accounts ORDER BY id`,
  );
  const insertStmt = raw.prepare(
    `INSERT INTO accounts (name, currency, starting_balance, leverage, mode)
     VALUES (@name, @currency, @startingBalance, @leverage, @mode)`,
  );

  const loadDrawingsStmt = raw.prepare(
    "SELECT payload, updated_at AS updatedAt FROM drawing_sets WHERE workspace = ?",
  );
  const saveDrawingsStmt = raw.prepare(
    `INSERT INTO drawing_sets (workspace, payload, updated_at)
     VALUES (@workspace, @payload, @updatedAt)
     ON CONFLICT(workspace) DO UPDATE SET
       payload = excluded.payload, updated_at = excluded.updated_at`,
  );

  const loadJournalStmt = raw.prepare(
    "SELECT payload FROM journal ORDER BY exit_time",
  );
  const saveJournalStmt = raw.prepare(
    `INSERT INTO journal (id, payload, exit_time) VALUES (@id, @payload, @exitTime)
     ON CONFLICT(id) DO UPDATE SET payload = excluded.payload,
       exit_time = excluded.exit_time`,
  );
  // Entries removed in the UI must disappear from disk too, so the write is a
  // replace: delete everything not in the incoming set, then upsert the rest, in
  // one transaction. A partial write would leave ghost trades in the analytics.
  const deleteMissingStmt = raw.prepare(
    "DELETE FROM journal WHERE id NOT IN (SELECT value FROM json_each(?))",
  );

  const getSettingStmt = raw.prepare("SELECT value FROM settings WHERE key = ?");
  const setSettingStmt = raw.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  const saveJournalTx = raw.transaction((entries: readonly JournalEntry[]) => {
    const ids = JSON.stringify(entries.map((e) => e.id));
    deleteMissingStmt.run(ids);
    for (const e of entries) {
      saveJournalStmt.run({
        id: e.id,
        payload: JSON.stringify(e),
        exitTime: e.exitTime,
      });
    }
  });

  return {
    raw,
    listAccounts: () => listStmt.all() as AccountRow[],
    createAccount: (a) => {
      const info = insertStmt.run(a);
      return Number(info.lastInsertRowid);
    },

    loadDrawings: (workspace) => {
      const row = loadDrawingsStmt.get(workspace) as
        | { payload: string; updatedAt: number }
        | undefined;
      if (!row) return { raw: null, updatedAt: null };
      // no decoding here on purpose: the renderer parses once (see RawLoadResult)
      return { raw: row.payload, updatedAt: row.updatedAt };
    },
    saveDrawings: (workspace, drawings) => {
      saveDrawingsStmt.run({
        workspace,
        payload: JSON.stringify(serialiseDrawings(drawings)),
        updatedAt: Date.now(),
      });
    },

    loadJournal: () => {
      const rows = loadJournalStmt.all() as Array<{ payload: string }>;
      const rejected: string[] = [];
      const value: JournalEntry[] = [];
      for (const row of rows) {
        try {
          const r = parseJournal({ entries: [JSON.parse(row.payload)] });
          value.push(...r.value);
          rejected.push(...r.rejected);
        } catch (e) {
          rejected.push(`unreadable row: ${(e as Error).message}`);
        }
      }
      return { value, rejected, updatedAt: null };
    },
    saveJournal: (entries) => {
      saveJournalTx(entries);
    },

    saveNews: (events) => {
      // Replace wholesale: a calendar import is a snapshot, not an append. Keeping old
      // rows would leave events for weeks the user has no data for and silently widen
      // the blackout windows.
      const tx = raw.transaction(() => {
        raw.prepare("DELETE FROM news").run();
        const ins = raw.prepare(
          "INSERT INTO news (time, currency, impact, title) VALUES (?, ?, ?, ?)",
        );
        for (const e of events) ins.run(e.time, e.currency, e.impact, e.title);
      });
      tx();
      return events.length;
    },
    loadNews: () => {
      return raw
        .prepare("SELECT time, currency, impact, title FROM news ORDER BY time")
        .all() as NewsRow[];
    },

    getSetting: (key) => {
      const row = getSettingStmt.get(key) as { value: string } | undefined;
      return row ? row.value : null;
    },
    setSetting: (key, value) => {
      setSettingStmt.run(key, value);
    },

    close: () => raw.close(),
  };
}
