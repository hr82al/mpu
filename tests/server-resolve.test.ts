import { describe, it, expect } from '@jest/globals';
import { resolveServerIp, looksLikeIp } from '../src/lib/server-resolve.js';

const envOf = (m: Record<string, string>) => (k: string) => m[k];

describe('looksLikeIp', () => {
  it('Проверяет: распознаёт IPv4-адреса', () => {
    expect(looksLikeIp('192.168.150.31')).toBe(true);
    expect(looksLikeIp('10.0.0.1')).toBe(true);
  });

  it('Проверяет: всё прочее — не IP', () => {
    expect(looksLikeIp('sl-1')).toBe(false);
    expect(looksLikeIp('sl_1')).toBe(false);
    expect(looksLikeIp('1abc')).toBe(false);
    expect(looksLikeIp('')).toBe(false);
    expect(looksLikeIp('256.0.0.1')).toBe(true); // допустимо для нашего кейса (сначала regex, валидацию октета не делаем)
  });
});

describe('resolveServerIp', () => {
  it('Проверяет: IP возвращается как есть', () => {
    expect(resolveServerIp('192.168.150.31', envOf({}))).toBe('192.168.150.31');
  });

  it('Проверяет: пробует ключ как есть, потом замену - на _, потом UPPERCASE', () => {
    expect(resolveServerIp('sl-1', envOf({ 'sl-1': '10.0.0.1' }))).toBe('10.0.0.1');
    expect(resolveServerIp('sl-1', envOf({ sl_1: '10.0.0.2' }))).toBe('10.0.0.2');
    expect(resolveServerIp('sl-1', envOf({ SL_1: '10.0.0.3' }))).toBe('10.0.0.3');
  });

  it('Проверяет: первое попадание выигрывает (точное имя > _-вариант > UPPER)', () => {
    expect(
      resolveServerIp(
        'sl-1',
        envOf({ 'sl-1': '1.1.1.1', sl_1: '2.2.2.2', SL_1: '3.3.3.3' }),
      ),
    ).toBe('1.1.1.1');
  });

  it('Проверяет: ничего не найдено → понятная ошибка с подсказкой что добавить в .env', () => {
    expect(() => resolveServerIp('sl-99', envOf({}))).toThrow(/sl-99/);
    expect(() => resolveServerIp('sl-99', envOf({}))).toThrow(/\.env/);
  });
});
