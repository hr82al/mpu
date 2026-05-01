import type { DB } from './db.js';
import { getDefaultDb } from './db.js';

export interface SlClientRow {
  clientId: number;
  server: string | null;
  isActive: boolean;
  isLocked: boolean;
  isDeleted: boolean;
}

interface SlClientDb {
  client_id: number;
  server: string | null;
  is_active: number;
  is_locked: number;
  is_deleted: number;
}

export class SlClients {
  private readonly delAll;
  private readonly insertOne;
  private readonly selOne;
  private readonly selAll;
  private readonly selByServer;
  private readonly cnt;

  constructor(private readonly db: DB) {
    this.delAll = db.prepare('DELETE FROM sl_clients');
    this.insertOne = db.prepare(
      `INSERT INTO sl_clients
         (client_id, server, is_active, is_locked, is_deleted, synced_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.selOne = db.prepare<[number], SlClientDb>(
      'SELECT client_id, server, is_active, is_locked, is_deleted FROM sl_clients WHERE client_id = ?',
    );
    this.selAll = db.prepare<[], SlClientDb>(
      'SELECT client_id, server, is_active, is_locked, is_deleted FROM sl_clients ORDER BY client_id',
    );
    this.selByServer = db.prepare<[string], SlClientDb>(
      'SELECT client_id, server, is_active, is_locked, is_deleted FROM sl_clients WHERE server = ? ORDER BY client_id',
    );
    this.cnt = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM sl_clients');
  }

  replaceAll(rows: SlClientRow[]): void {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.delAll.run();
      for (const r of rows) {
        this.insertOne.run(
          r.clientId,
          r.server,
          r.isActive ? 1 : 0,
          r.isLocked ? 1 : 0,
          r.isDeleted ? 1 : 0,
          now,
        );
      }
    });
    tx();
  }

  count(): number {
    return this.cnt.get()?.n ?? 0;
  }

  get(clientId: number): SlClientRow | undefined {
    const r = this.selOne.get(clientId);
    return r ? toRow(r) : undefined;
  }

  list(): SlClientRow[] {
    return this.selAll.all().map(toRow);
  }

  byServer(server: string): SlClientRow[] {
    return this.selByServer.all(server).map(toRow);
  }
}

function toRow(r: SlClientDb): SlClientRow {
  return {
    clientId: r.client_id,
    server: r.server,
    isActive: r.is_active !== 0,
    isLocked: r.is_locked !== 0,
    isDeleted: r.is_deleted !== 0,
  };
}

let defaultInstance: SlClients | null = null;
export function getDefaultSlClients(): SlClients {
  if (!defaultInstance) defaultInstance = new SlClients(getDefaultDb());
  return defaultInstance;
}
