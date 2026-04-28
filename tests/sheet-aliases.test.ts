import { describe, it, expect, beforeEach } from '@jest/globals';
import type Database from 'better-sqlite3';
import { openDb } from '../src/lib/db.js';
import { SheetAliases } from '../src/lib/sheet-aliases.js';

describe('SheetAliases', () => {
  let db: Database.Database;
  let aliases: SheetAliases;

  beforeEach(() => {
    db = openDb(':memory:');
    aliases = new SheetAliases(db);
  });

  it('Проверяет: add+get round-trip', () => {
    aliases.add('prod', '1abc');
    expect(aliases.get('prod')).toBe('1abc');
  });

  it('Проверяет: get на несуществующее имя — undefined', () => {
    expect(aliases.get('nope')).toBeUndefined();
  });

  it('Проверяет: add повторно — заменяет (upsert)', () => {
    aliases.add('prod', '1abc');
    aliases.add('prod', '2xyz');
    expect(aliases.get('prod')).toBe('2xyz');
  });

  it('Проверяет: list возвращает все алиасы отсортированные по имени', () => {
    aliases.add('zeta', '3');
    aliases.add('alpha', '1');
    aliases.add('beta', '2');
    expect(aliases.list().map((a) => a.name)).toEqual(['alpha', 'beta', 'zeta']);
  });

  it('Проверяет: remove удаляет алиас', () => {
    aliases.add('x', '1');
    aliases.remove('x');
    expect(aliases.get('x')).toBeUndefined();
  });

  it('Проверяет: remove несуществующего — no-op (не бросает)', () => {
    expect(() => aliases.remove('ghost')).not.toThrow();
  });

  it('Проверяет: пустое имя отвергается', () => {
    expect(() => aliases.add('', '1abc')).toThrow();
  });

  it('Проверяет: имя с пробелами отвергается (нужно что-то URL/shell-friendly)', () => {
    expect(() => aliases.add('with space', '1abc')).toThrow();
  });
});
