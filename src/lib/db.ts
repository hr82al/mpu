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
