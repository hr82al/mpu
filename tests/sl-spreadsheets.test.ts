import { describe, it, expect, beforeEach } from '@jest/globals';
import type Database from 'better-sqlite3';
import { openDb } from '../src/lib/db.js';
import { SlSpreadsheets, type SlSpreadsheetRow } from '../src/lib/sl-spreadsheets.js';

const sample: SlSpreadsheetRow[] = [
  { ssId: '1abcAAA', clientId: 42, title: 'Cool Flaps', templateName: 'unit_v2', isActive: true, server: 'sl-1' },
  { ssId: '1abcBBB', clientId: 42, title: 'Cool Flaps Backup', templateName: 'unit_v2', isActive: false, server: 'sl-1' },
  { ssId: '1abcCCC', clientId: 54, title: 'Hot Sneakers', templateName: 'unit_v3', isActive: true, server: 'sl-2' },
  { ssId: '1abcDDD', clientId: 99, title: 'Misc Other', templateName: 'unit_v1', isActive: true, server: 'sl-2' },
];

describe('SlSpreadsheets', () => {
  let db: Database.Database;
  let store: SlSpreadsheets;

  beforeEach(() => {
    db = openDb(':memory:');
    store = new SlSpreadsheets(db);
  });

  it('Проверяет: replaceAll сохраняет все строки и обнуляет старые', () => {
    store.replaceAll(sample);
    expect(store.count()).toBe(4);
    store.replaceAll([sample[0]!]);
    expect(store.count()).toBe(1);
  });

  it('Проверяет: byClientId возвращает все совпадения', () => {
    store.replaceAll(sample);
    const r = store.byClientId(42);
    expect(r.map((x) => x.ssId).sort()).toEqual(['1abcAAA', '1abcBBB']);
  });

  it('Проверяет: fuzzyByTitle ранжирует похожие', () => {
    store.replaceAll(sample);
    const r = store.fuzzyByTitle('cool flaps', 5);
    expect(r[0]!.ssId).toBe('1abcAAA');
    expect(r.find((x) => x.ssId === '1abcCCC')).toBeUndefined();
  });

  it('Проверяет: fuzzyByTitle падает gracefully на пустой выборке', () => {
    expect(store.fuzzyByTitle('anything', 5)).toEqual([]);
  });

  it('Проверяет: list возвращает всё, сортированно по client_id then title', () => {
    store.replaceAll(sample);
    const r = store.list();
    expect(r.map((x) => x.ssId)).toEqual(['1abcAAA', '1abcBBB', '1abcCCC', '1abcDDD']);
  });
});
