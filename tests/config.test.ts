import { describe, it, expect, beforeEach } from '@jest/globals';
import { openDb } from '../src/lib/db.js';
import { Config } from '../src/lib/config.js';

describe('Config', () => {
  let config: Config;

  beforeEach(() => {
    config = new Config(openDb(':memory:'));
  });

  it('Проверяет: возвращает дефолт для необъявленных ключей', () => {
    expect(config.get('cache.ttl')).toBe(3600);
  });

  it('Проверяет: int сохраняется и валидируется', () => {
    config.set('cache.ttl', '60');
    expect(config.get('cache.ttl')).toBe(60);
    expect(() => config.set('cache.ttl', '-1')).toThrow(/>= 0/);
    expect(() => config.set('cache.ttl', 'abc')).toThrow(/integer/);
  });

  it('Проверяет: unset сбрасывает к default', () => {
    config.set('cache.ttl', 100);
    expect(config.get('cache.ttl')).toBe(100);
    config.unset('cache.ttl');
    expect(config.get('cache.ttl')).toBe(3600);
  });

  it('Проверяет: list возвращает все ключи с флагом overridden', () => {
    const before = config.list();
    expect(before.find((e) => e.key === 'cache.ttl')?.overridden).toBe(false);
    config.set('cache.ttl', 42);
    const after = config.list();
    const ttl = after.find((e) => e.key === 'cache.ttl');
    expect(ttl?.overridden).toBe(true);
    expect(ttl?.value).toBe(42);
  });

  it('Проверяет: неизвестные ключи отвергаются с подсказкой', () => {
    expect(() => config.get('unknown')).toThrow(/Valid keys/);
    expect(() => config.set('unknown', 'x')).toThrow(/Valid keys/);
    expect(() => config.unset('unknown')).toThrow(/Valid keys/);
  });

  it('Проверяет: значения переживают переоткрытие Config на той же БД', () => {
    const db = openDb(':memory:');
    const a = new Config(db);
    a.set('cache.ttl', 123);
    const b = new Config(db);
    expect(b.get('cache.ttl')).toBe(123);
  });
});
