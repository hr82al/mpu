import type { DB } from './db.js';
import { getDefaultDb } from './db.js';
import { Config, getDefaultConfig } from './config.js';

export interface CacheOptions {
  /**
   * TTL в секундах.
   * - undefined: использовать `cache.ttl` из конфига
   * - 0: не кэшировать (set становится no-op)
   * - Infinity: никогда не истекает
   */
  ttl?: number;
}

interface CacheRow {
  value: string;
  expires_at: number | null;
}

export class Cache {
  private getStmt;
  private setStmt;
  private delStmt;
  private clearStmt;

  constructor(
    db: DB,
    private readonly config: Config,
  ) {
    this.getStmt = db.prepare<[string], CacheRow>(
      'SELECT value, expires_at FROM cache WHERE key = ?',
    );
    this.setStmt = db.prepare(
      'INSERT INTO cache (key, value, created_at, expires_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET ' +
        'value = excluded.value, created_at = excluded.created_at, expires_at = excluded.expires_at',
    );
    this.delStmt = db.prepare('DELETE FROM cache WHERE key = ?');
    this.clearStmt = db.prepare('DELETE FROM cache');
  }

  /**
   * `cache.ttl = 0` — единственный способ отключить кэш глобально.
   * Master-switch: при нём не помогает даже per-call `opts.ttl` override.
   */
  private isDisabled(): boolean {
    return this.config.get('cache.ttl') === 0;
  }

  get<T>(key: string): T | undefined {
    if (this.isDisabled()) return undefined;
    const row = this.getStmt.get(key);
    if (!row) return undefined;
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      this.delStmt.run(key);
      return undefined;
    }
    return JSON.parse(row.value) as T;
  }

  set<T>(key: string, value: T, opts: CacheOptions = {}): void {
    if (this.isDisabled()) return;
    if (value === undefined) throw new Error('cache: cannot store undefined');
    const ttl = opts.ttl ?? this.config.get('cache.ttl');
    if (ttl === 0) return;
    if (ttl < 0) throw new Error(`cache: ttl must be >= 0, got ${ttl}`);
    const now = Date.now();
    const expiresAt = ttl === Infinity ? null : now + ttl * 1000;
    this.setStmt.run(key, JSON.stringify(value), now, expiresAt);
  }

  delete(key: string): void {
    this.delStmt.run(key);
  }

  clear(): void {
    this.clearStmt.run();
  }

  wrap<T>(key: string, fn: () => T, opts?: CacheOptions): T {
    const hit = this.get<T>(key);
    if (hit !== undefined) return hit;
    const value = fn();
    this.set(key, value, opts);
    return value;
  }

  async wrapAsync<T>(key: string, fn: () => Promise<T>, opts?: CacheOptions): Promise<T> {
    const hit = this.get<T>(key);
    if (hit !== undefined) return hit;
    const value = await fn();
    this.set(key, value, opts);
    return value;
  }
}

let defaultInstance: Cache | null = null;
export function getDefaultCache(): Cache {
  if (!defaultInstance) defaultInstance = new Cache(getDefaultDb(), getDefaultConfig());
  return defaultInstance;
}
