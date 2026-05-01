import { describe, it, expect, beforeEach } from '@jest/globals';
import type Database from 'better-sqlite3';
import { openDb } from '../src/lib/db.js';
import { SlClients, type SlClientRow } from '../src/lib/sl-clients.js';

const sample: SlClientRow[] = [
  { clientId: 42, server: 'sl-1', isActive: true, isLocked: false, isDeleted: false },
  { clientId: 54, server: 'sl-2', isActive: true, isLocked: false, isDeleted: false },
  { clientId: 99, server: 'sl-2', isActive: false, isLocked: true, isDeleted: false },
  { clientId: 100, server: null, isActive: true, isLocked: false, isDeleted: true },
];

describe('SlClients', () => {
  let db: Database.Database;
  let store: SlClients;

  beforeEach(() => {
    db = openDb(':memory:');
    store = new SlClients(db);
  });

  it('Проверяет: replaceAll сохраняет все строки и обнуляет старые', () => {
    store.replaceAll(sample);
    expect(store.count()).toBe(4);
    store.replaceAll([sample[0]!]);
    expect(store.count()).toBe(1);
  });

  it('Проверяет: get(clientId) возвращает строку или undefined', () => {
    store.replaceAll(sample);
    expect(store.get(42)?.server).toBe('sl-1');
    expect(store.get(99)?.isLocked).toBe(true);
    expect(store.get(100)?.server).toBeNull();
    expect(store.get(404)).toBeUndefined();
  });

  it('Проверяет: list возвращает всё, отсортированно по client_id', () => {
    store.replaceAll(sample);
    const r = store.list();
    expect(r.map((x) => x.clientId)).toEqual([42, 54, 99, 100]);
  });

  it('Проверяет: byServer фильтрует по имени сервера (включая null)', () => {
    store.replaceAll(sample);
    expect(store.byServer('sl-2').map((x) => x.clientId).sort()).toEqual([54, 99]);
    expect(store.byServer('sl-99')).toEqual([]);
  });
});
