import Fuse from 'fuse.js';
import type { DB } from './db.js';
import { getDefaultDb } from './db.js';

export interface SlSpreadsheetRow {
  ssId: string;
  clientId: number;
  title: string;
  templateName: string | null;
  isActive: boolean;
  server: string | null;
}

export class SlSpreadsheets {
  private readonly delAll;
  private readonly insertOne;
  private readonly selByClient;
  private readonly selAll;
  private readonly cnt;

  constructor(private readonly db: DB) {
    this.delAll = db.prepare('DELETE FROM sl_spreadsheets');
    this.insertOne = db.prepare(
      `INSERT INTO sl_spreadsheets
         (ss_id, client_id, title, template_name, is_active, server, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.selByClient = db.prepare<[number], SlRowDb>(
      'SELECT ss_id, client_id, title, template_name, is_active, server FROM sl_spreadsheets WHERE client_id = ?',
    );
    this.selAll = db.prepare<[], SlRowDb>(
      'SELECT ss_id, client_id, title, template_name, is_active, server FROM sl_spreadsheets ORDER BY client_id, title',
    );
    this.cnt = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM sl_spreadsheets');
  }

  replaceAll(rows: SlSpreadsheetRow[]): void {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.delAll.run();
      for (const r of rows) {
        this.insertOne.run(
          r.ssId,
          r.clientId,
          r.title,
          r.templateName,
          r.isActive ? 1 : 0,
          r.server,
          now,
        );
      }
    });
    tx();
  }

  count(): number {
    return this.cnt.get()?.n ?? 0;
  }

  byClientId(clientId: number): SlSpreadsheetRow[] {
    return this.selByClient.all(clientId).map(toRow);
  }

  list(): SlSpreadsheetRow[] {
    return this.selAll.all().map(toRow);
  }

  fuzzyByTitle(query: string, limit: number): SlSpreadsheetRow[] {
    const all = this.list();
    if (all.length === 0) return [];
    const fuse = new Fuse(all, { keys: ['title'], threshold: 0.5, includeScore: true });
    return fuse.search(query, { limit }).map((r) => r.item);
  }
}

interface SlRowDb {
  ss_id: string;
  client_id: number;
  title: string;
  template_name: string | null;
  is_active: number;
  server: string | null;
}

function toRow(r: SlRowDb): SlSpreadsheetRow {
  return {
    ssId: r.ss_id,
    clientId: r.client_id,
    title: r.title,
    templateName: r.template_name,
    isActive: r.is_active !== 0,
    server: r.server,
  };
}

let defaultInstance: SlSpreadsheets | null = null;
export function getDefaultSlSpreadsheets(): SlSpreadsheets {
  if (!defaultInstance) defaultInstance = new SlSpreadsheets(getDefaultDb());
  return defaultInstance;
}
