import { describe, it, expect, jest } from '@jest/globals';
import {
  parseSpreadsheetUrl,
  resolveSpreadsheetId,
  resolveRanges,
  qualifyRanges,
  SpreadsheetResolveError,
} from '../src/lib/spreadsheet.js';

describe('parseSpreadsheetUrl', () => {
  it('Проверяет: вытаскивает ID из стандартного URL', () => {
    expect(
      parseSpreadsheetUrl(
        'https://docs.google.com/spreadsheets/d/1abcDEF_xyz-123/edit#gid=0',
      ),
    ).toBe('1abcDEF_xyz-123');
  });

  it('Проверяет: возвращает вход если это похоже на голый ID', () => {
    expect(parseSpreadsheetUrl('1abcDEF_xyz-123')).toBe('1abcDEF_xyz-123');
  });

  it('Проверяет: бросает на пустой строке', () => {
    expect(() => parseSpreadsheetUrl('')).toThrow();
  });

  it('Проверяет: бросает на явно невалидной строке', () => {
    expect(() => parseSpreadsheetUrl('https://example.com/foo')).toThrow(/spreadsheet/i);
  });
});

describe('resolveSpreadsheetId', () => {
  it('Проверяет: --spreadsheet выигрывает у всех остальных источников', () => {
    expect(
      resolveSpreadsheetId({
        flag: '1abc',
        env: () => 'envid',
        configDefault: () => 'cfgid',
      }),
    ).toEqual({ id: '1abc', source: 'flag' });
  });

  it('Проверяет: env используется если флаг пуст', () => {
    expect(
      resolveSpreadsheetId({
        flag: undefined,
        env: () => 'envid',
        configDefault: () => 'cfgid',
      }),
    ).toEqual({ id: 'envid', source: 'env' });
  });

  it('Проверяет: config-default используется если ни флаг, ни env не дают', () => {
    expect(
      resolveSpreadsheetId({
        flag: undefined,
        env: () => undefined,
        configDefault: () => 'cfgid',
      }),
    ).toEqual({ id: 'cfgid', source: 'config' });
  });

  it('Проверяет: бросает SpreadsheetResolveError с перечислением проверенных источников', () => {
    let caught: SpreadsheetResolveError | undefined;
    try {
      resolveSpreadsheetId({
        flag: undefined,
        env: () => undefined,
        configDefault: () => undefined,
      });
    } catch (e) {
      caught = e as SpreadsheetResolveError;
    }
    expect(caught).toBeInstanceOf(SpreadsheetResolveError);
    expect(caught!.message).toMatch(/--spreadsheet/);
    expect(caught!.message).toMatch(/MPU_SS/);
    expect(caught!.message).toMatch(/sheet\.default/);
  });

  it('Проверяет: URL во флаге распарсится', () => {
    expect(
      resolveSpreadsheetId({
        flag: 'https://docs.google.com/spreadsheets/d/1abc/edit',
        env: () => undefined,
        configDefault: () => undefined,
      }),
    ).toEqual({ id: '1abc', source: 'flag' });
  });

  it('Проверяет: alias во флаге резолвится через lookupAlias', () => {
    const r = resolveSpreadsheetId({
      flag: 'prod',
      env: () => undefined,
      configDefault: () => undefined,
      lookupAlias: (n) => (n === 'prod' ? '1prodID_xxxxxxxxxxxxxxxx' : undefined),
    });
    expect(r).toEqual({ id: '1prodID_xxxxxxxxxxxxxxxx', source: 'flag', alias: 'prod' });
  });

  it('Проверяет: smart-resolve — единственный кандидат разрешается', () => {
    const r = resolveSpreadsheetId({
      flag: '42',
      env: () => undefined,
      configDefault: () => undefined,
      lookupCandidates: (q) =>
        q === '42'
          ? [
              {
                ssId: '1abcID_xxxxxxxxxxxxxxxx',
                clientId: 42,
                title: 'Cool',
                templateName: 'unit',
                isActive: true,
                server: 'sl-1',
              },
            ]
          : [],
    });
    expect(r.id).toBe('1abcID_xxxxxxxxxxxxxxxx');
    expect(r.candidate?.clientId).toBe(42);
  });

  it('Проверяет: smart-resolve — неоднозначность бросает AmbiguousSpreadsheetError', async () => {
    const { AmbiguousSpreadsheetError } = await import('../src/lib/spreadsheet.js');
    let err: unknown;
    try {
      resolveSpreadsheetId({
        flag: 'cool',
        env: () => undefined,
        configDefault: () => undefined,
        lookupCandidates: () => [
          { ssId: 'A', clientId: 1, title: 'Cool A', templateName: null, isActive: true, server: null },
          { ssId: 'B', clientId: 2, title: 'Cool B', templateName: null, isActive: true, server: null },
        ],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AmbiguousSpreadsheetError);
    expect((err as Error).message).toMatch(/multiple/);
    expect((err as Error).message).toMatch(/Cool A/);
    expect((err as Error).message).toMatch(/Cool B/);
  });

  it('Проверяет: smart-resolve — пустой результат → fallback к parseSpreadsheetUrl', () => {
    const r = resolveSpreadsheetId({
      flag: 'mystery',
      env: () => undefined,
      configDefault: () => undefined,
      lookupCandidates: () => [],
    });
    expect(r.id).toBe('mystery');
  });

  it('Проверяет: длинный ID не идёт через alias-lookup', () => {
    const lookup = jest.fn<(n: string) => string | undefined>();
    resolveSpreadsheetId({
      flag: '1abcDEF_xyz_12345678901234567890',
      env: () => undefined,
      configDefault: () => undefined,
      lookupAlias: lookup,
    });
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('resolveRanges', () => {
  it('Проверяет: позиционные диапазоны проходят как есть', async () => {
    const r = await resolveRanges({
      positional: ['Sheet1!A1:B2', 'Sheet2!C3'],
      sheet: undefined,
      from: undefined,
      readFile: async () => '',
      readStdin: async () => '',
    });
    expect(r).toEqual(['Sheet1!A1:B2', 'Sheet2!C3']);
  });

  it('Проверяет: --sheet добавляется к позиционным без префикса', async () => {
    const r = await resolveRanges({
      positional: ['A1:B2', 'C3'],
      sheet: 'Лист',
      from: undefined,
      readFile: async () => '',
      readStdin: async () => '',
    });
    expect(r).toEqual(['Лист!A1:B2', 'Лист!C3']);
  });

  it('Проверяет: позиционные с явным листом не модифицируются даже при --sheet', async () => {
    const r = await resolveRanges({
      positional: ['Other!A1', 'B2:C3'],
      sheet: 'Лист',
      from: undefined,
      readFile: async () => '',
      readStdin: async () => '',
    });
    expect(r).toEqual(['Other!A1', 'Лист!B2:C3']);
  });

  it('Проверяет: --from <file> читает файл, игнорирует комментарии и пустые строки', async () => {
    const r = await resolveRanges({
      positional: [],
      sheet: undefined,
      from: '/tmp/ranges.txt',
      readFile: async (p) => {
        expect(p).toBe('/tmp/ranges.txt');
        return ['# header', '', 'Sheet1!A1', '  Sheet1!B2  ', '#skip', 'Sheet2!C3'].join('\n');
      },
      readStdin: async () => '',
    });
    expect(r).toEqual(['Sheet1!A1', 'Sheet1!B2', 'Sheet2!C3']);
  });

  it('Проверяет: --from - читает stdin', async () => {
    const r = await resolveRanges({
      positional: [],
      sheet: undefined,
      from: '-',
      readFile: async () => {
        throw new Error('should not call file reader');
      },
      readStdin: async () => 'Sheet1!A1\nSheet1!A2',
    });
    expect(r).toEqual(['Sheet1!A1', 'Sheet1!A2']);
  });

  it('Проверяет: позиционные + --from объединяются с дедупликацией порядка', async () => {
    const r = await resolveRanges({
      positional: ['Sheet1!A1'],
      sheet: undefined,
      from: '-',
      readFile: async () => '',
      readStdin: async () => 'Sheet1!A1\nSheet1!B2',
    });
    expect(r).toEqual(['Sheet1!A1', 'Sheet1!B2']);
  });

  it('Проверяет: пустой результат — ошибка с подсказкой', async () => {
    await expect(
      resolveRanges({
        positional: [],
        sheet: undefined,
        from: undefined,
        readFile: async () => '',
        readStdin: async () => '',
      }),
    ).rejects.toThrow(/range/i);
  });

  it('Проверяет: позиционный без префикса и без --sheet — ошибка с указанием значения', async () => {
    await expect(
      resolveRanges({
        positional: ['A1:B2'],
        sheet: undefined,
        from: undefined,
        readFile: async () => '',
        readStdin: async () => '',
      }),
    ).rejects.toThrow(/A1:B2/);
  });
});

describe('qualifyRanges', () => {
  it('Проверяет: добавляет лист если префикса нет', () => {
    expect(qualifyRanges(['A1', 'Sheet!B2', 'C3:D4'], 'Default')).toEqual([
      'Default!A1',
      'Sheet!B2',
      'Default!C3:D4',
    ]);
  });

  it('Проверяет: без листа и без префикса — бросает с указанием значения', () => {
    expect(() => qualifyRanges(['A1'], undefined)).toThrow(/A1/);
  });
});
