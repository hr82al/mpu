import type { DB } from './db.js';
import { getDefaultDb } from './db.js';

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

export interface AliasEntry {
  name: string;
  ssId: string;
  createdAt: number;
}

export class SheetAliases {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly listStmt;
  private readonly delStmt;

  constructor(db: DB) {
    this.upsertStmt = db.prepare(
      `INSERT INTO sheet_aliases (name, ss_id, created_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET ss_id = excluded.ss_id, created_at = excluded.created_at`,
    );
    this.getStmt = db.prepare<[string], { ss_id: string }>(
      'SELECT ss_id FROM sheet_aliases WHERE name = ?',
    );
    this.listStmt = db.prepare<[], { name: string; ss_id: string; created_at: number }>(
      'SELECT name, ss_id, created_at FROM sheet_aliases ORDER BY name',
    );
    this.delStmt = db.prepare('DELETE FROM sheet_aliases WHERE name = ?');
  }

  add(name: string, ssId: string): void {
    if (!name) throw new Error('alias name is empty');
    if (!NAME_RE.test(name)) {
      throw new Error(
        `alias name "${name}" must contain only [A-Za-z0-9_.-] (no spaces, no special chars)`,
      );
    }
    if (!ssId) throw new Error('spreadsheet ID is empty');
    this.upsertStmt.run(name, ssId, Date.now());
  }

  get(name: string): string | undefined {
    return this.getStmt.get(name)?.ss_id;
  }

  list(): AliasEntry[] {
    return this.listStmt
      .all()
      .map((r) => ({ name: r.name, ssId: r.ss_id, createdAt: r.created_at }));
  }

  remove(name: string): void {
    this.delStmt.run(name);
  }
}

let defaultInstance: SheetAliases | null = null;
export function getDefaultSheetAliases(): SheetAliases {
  if (!defaultInstance) defaultInstance = new SheetAliases(getDefaultDb());
  return defaultInstance;
}
