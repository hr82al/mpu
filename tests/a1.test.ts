import { describe, it, expect } from '@jest/globals';
import { parseA1, colA1ToNum, colNumToA1, A1ParseError } from '../src/lib/a1.js';

describe('colA1ToNum / colNumToA1', () => {
  const cases: Array<[string, number]> = [
    ['A', 1],
    ['B', 2],
    ['Z', 26],
    ['AA', 27],
    ['AZ', 52],
    ['BA', 53],
    ['ZZ', 702],
    ['AAA', 703],
  ];
  it.each(cases)('A1 col %s → %d', (letters, num) => {
    expect(colA1ToNum(letters)).toBe(num);
    expect(colNumToA1(num)).toBe(letters);
  });

  it('Проверяет: case-insensitive', () => {
    expect(colA1ToNum('aa')).toBe(27);
  });

  it('Проверяет: невалидное имя бросает', () => {
    expect(() => colA1ToNum('1A')).toThrow();
    expect(() => colA1ToNum('')).toThrow();
  });
});

describe('parseA1', () => {
  it('Проверяет: одиночная ячейка', () => {
    expect(parseA1('Sheet1!B5')).toEqual({
      sheet: 'Sheet1',
      r1: 5,
      c1: 2,
      r2: 5,
      c2: 2,
      wholeSheet: false,
    });
  });

  it('Проверяет: диапазон', () => {
    expect(parseA1('Лист!A1:C3')).toEqual({
      sheet: 'Лист',
      r1: 1,
      c1: 1,
      r2: 3,
      c2: 3,
      wholeSheet: false,
    });
  });

  it('Проверяет: имя листа в одинарных кавычках', () => {
    expect(parseA1("'My Sheet'!A1:B2").sheet).toBe('My Sheet');
  });

  it('Проверяет: лист без диапазона → wholeSheet=true', () => {
    expect(parseA1('Sheet1')).toMatchObject({
      sheet: 'Sheet1',
      wholeSheet: true,
    });
  });

  it('Проверяет: нормализация порядка координат', () => {
    expect(parseA1('S!C3:A1')).toMatchObject({ r1: 1, c1: 1, r2: 3, c2: 3 });
  });

  it('Проверяет: невалидный формат бросает A1ParseError с указанием значения', () => {
    expect(() => parseA1('S!')).toThrow(A1ParseError);
    expect(() => parseA1('S!A')).toThrow(/A1/);
  });

  it('Проверяет: open-ended row range A:A не поддерживается (бросает)', () => {
    expect(() => parseA1('S!A:A')).toThrow();
  });
});
