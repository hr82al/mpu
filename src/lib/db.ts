import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultDbPath } from './paths.js';

export type DB = Database.Database;

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS config (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS cache (
     key        TEXT PRIMARY KEY,
     value      TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at)`,
  `CREATE TABLE IF NOT EXISTS sheet_cells (
     ss_id      TEXT NOT NULL,
     sheet      TEXT NOT NULL,
     row        INTEGER NOT NULL,
     col        INTEGER NOT NULL,
     v_json     TEXT,
     f_text     TEXT,
     fetched_at INTEGER NOT NULL,
     PRIMARY KEY (ss_id, sheet, row, col)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sheet_cells_rect ON sheet_cells(ss_id, sheet, row, col)`,
  `CREATE TABLE IF NOT EXISTS sheet_aliases (
     name       TEXT PRIMARY KEY,
     ss_id      TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sl_spreadsheets (
     ss_id          TEXT PRIMARY KEY,
     client_id      INTEGER NOT NULL,
     title          TEXT NOT NULL,
     template_name  TEXT,
     is_active      INTEGER NOT NULL,
     server         TEXT,
     synced_at      INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sl_ss_client ON sl_spreadsheets(client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sl_ss_title ON sl_spreadsheets(title)`,
];

export function openDb(path: string = defaultDbPath()): DB {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  for (const sql of MIGRATIONS) db.exec(sql);
  return db;
}

let defaultInstance: DB | null = null;
export function getDefaultDb(): DB {
  if (!defaultInstance) defaultInstance = openDb();
  return defaultInstance;
}
