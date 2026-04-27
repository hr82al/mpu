import { describe, it, expect, beforeEach } from '@jest/globals';
import type Database from 'better-sqlite3';
import { openDb } from '../src/lib/db.js';
import { Config } from '../src/lib/config.js';
import { Cache } from '../src/lib/cache.js';

describe('Cache', () => {
  let db: Database.Database;
  let config: Config;
  let cache: Cache;

  beforeEach(() => {
    db = openDb(':memory:');
    config = new Config(db);
    cache = new Cache(db, config);
  });

  it('Проверяет: set/get round-trip с дефолтным TTL', () => {
    cache.set('k', { a: 1 });
    expect(cache.get<{ a: number }>('k')).toEqual({ a: 1 });
  });

  it('Проверяет: miss возвращает undefined', () => {
    expect(cache.get('missing')).toBeUndefined();
  });

  it('Проверяет: значение истекает после TTL', () => {
    cache.set('k', 'v', { ttl: 1 });
    db.prepare('UPDATE cache SET expires_at = ? WHERE key = ?').run(Date.now() - 1000, 'k');
    expect(cache.get('k')).toBeUndefined();
  });

  it('Проверяет: ttl=0 не кэширует', () => {
    cache.set('k', 'v', { ttl: 0 });
    expect(cache.get('k')).toBeUndefined();
  });

  it('Проверяет: ttl=Infinity — запись без expires_at', () => {
    cache.set('k', 'v', { ttl: Infinity });
    const row = db.prepare('SELECT expires_at FROM cache WHERE key = ?').get('k') as {
      expires_at: number | null;
    };
    expect(row.expires_at).toBeNull();
    expect(cache.get('k')).toBe('v');
  });

  it('Проверяет: ttl<0 отвергается', () => {
    expect(() => cache.set('k', 'v', { ttl: -1 })).toThrow(/>= 0/);
  });

  it('Проверяет: wrap — первый вызов считает, второй из кэша', () => {
    let calls = 0;
    const compute = () => ++calls;
    expect(cache.wrap('k', compute)).toBe(1);
    expect(cache.wrap('k', compute)).toBe(1);
    expect(calls).toBe(1);
  });

  it('Проверяет: wrapAsync — то же для асинхронного fn', async () => {
    let calls = 0;
    const compute = async () => ++calls;
    expect(await cache.wrapAsync('k', compute)).toBe(1);
    expect(await cache.wrapAsync('k', compute)).toBe(1);
    expect(calls).toBe(1);
  });

  it('Проверяет: кэш различает null и miss', () => {
    cache.set('k', null);
    expect(cache.get('k')).toBeNull();
    expect(cache.get('other')).toBeUndefined();
  });

  it('Проверяет: undefined нельзя сохранить', () => {
    expect(() => cache.set('k', undefined)).toThrow(/undefined/);
  });

  it('Проверяет: delete убирает одну запись, clear — все', () => {
    cache.set('a', 1);
    cache.set('b', 2);
    cache.delete('a');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    cache.clear();
    expect(cache.get('b')).toBeUndefined();
  });

  it('Проверяет: config.cache.ttl применяется как дефолт', () => {
    config.set('cache.ttl', 1);
    cache.set('k', 'v');
    db.prepare('UPDATE cache SET expires_at = ? WHERE key = ?').run(Date.now() - 1000, 'k');
    expect(cache.get('k')).toBeUndefined();
  });

  it('Проверяет: cache.ttl=0 — master-switch: get/set = no-op', () => {
    cache.set('k', 'v');
    expect(cache.get('k')).toBe('v');
    config.set('cache.ttl', 0);
    expect(cache.get('k')).toBeUndefined();
    cache.set('k2', 'v2');
    config.set('cache.ttl', 3600);
    expect(cache.get('k2')).toBeUndefined();
    expect(cache.get('k')).toBe('v');
  });

  it('Проверяет: cache.ttl=0 перекрывает per-call ttl override', () => {
    config.set('cache.ttl', 0);
    cache.set('k', 'v', { ttl: 600 });
    expect(cache.get('k')).toBeUndefined();
  });

  it('Проверяет: wrap с refresh=true пересчитывает и перезаписывает кэш', () => {
    let calls = 0;
    cache.wrap('k', () => ++calls);
    cache.wrap('k', () => ++calls);
    expect(calls).toBe(1);
    const v = cache.wrap('k', () => ++calls, { refresh: true });
    expect(calls).toBe(2);
    expect(v).toBe(2);
    expect(cache.get('k')).toBe(2);
  });

  it('Проверяет: wrapAsync с refresh=true пересчитывает асинхронно', async () => {
    let calls = 0;
    await cache.wrapAsync('k', async () => ++calls);
    expect(await cache.wrapAsync('k', async () => ++calls, { refresh: true })).toBe(2);
    expect(calls).toBe(2);
    expect(cache.get('k')).toBe(2);
  });

  it('Проверяет: cache.ttl=0 заставляет wrap() вычислять каждый раз', () => {
    config.set('cache.ttl', 0);
    let calls = 0;
    expect(cache.wrap('k', () => ++calls)).toBe(1);
    expect(cache.wrap('k', () => ++calls)).toBe(2);
    expect(calls).toBe(2);
  });
});
