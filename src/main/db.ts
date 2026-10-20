/**
 * SQLite persistence (better-sqlite3).
 *
 * Synchronous on purpose: the main process is not the UI thread, and every query
 * here is a handful of rows. The heavy data (candles) is NOT stored here -- it
 * lives in the columnar store -- so this database stays small and fast.
 *
 * Schema is created with IF NOT EXISTS and a user_version bump so an existing
 * user's file upgrades instead of being wiped.
 */
import Database from "better-sqlite3";

export interface AccountRow {
  id: number;
  name: string;
  currency: string;
  startingBalance: number;
  leverage: number;
  mode: string;
}

export interface Db {
  listAccounts(): AccountRow[];
  createAccount(a: Omit<AccountRow, "id">): number;
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

export function openDatabase(file: string): Db {
  const raw = new Database(file);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.exec(SCHEMA);
  raw.pragma("user_version = 1");

  const listStmt = raw.prepare(
    `SELECT id, name, currency, starting_balance AS startingBalance,
            leverage, mode
       FROM accounts ORDER BY id`,
  );
  const insertStmt = raw.prepare(
    `INSERT INTO accounts (name, currency, starting_balance, leverage, mode)
     VALUES (@name, @currency, @startingBalance, @leverage, @mode)`,
  );

  return {
    raw,
    listAccounts: () => listStmt.all() as AccountRow[],
    createAccount: (a) => {
      const info = insertStmt.run(a);
      return Number(info.lastInsertRowid);
    },
    close: () => raw.close(),
  };
}
