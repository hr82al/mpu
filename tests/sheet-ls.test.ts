import { describe, it, expect, jest } from '@jest/globals';
import { Command } from 'commander';
import { sheetCommand, formatLs } from '../src/commands/sheet.js';
import type { SheetDeps, SheetClient } from '../src/commands/sheet.js';
import { Cache } from '../src/lib/cache.js';
import { Config } from '../src/lib/config.js';
import { openDb } from '../src/lib/db.js';

type DoFn = <T = unknown>(action: string, payload: Record<string, unknown>) => Promise<T>;

interface FakeClient {
  do: jest.Mock<DoFn>;
}

function makeDeps(over: Partial<SheetDeps> = {}): {
  deps: SheetDeps;
  client: FakeClient;
  output: string[];
  cache: Cache;
} {
  const doMock = jest.fn<DoFn>();
  const client: FakeClient = { do: doMock };
  const output: string[] = [];
  const db = openDb(':memory:');
  const config = new Config(db);
  const cache = new Cache(db, config);
  const deps: SheetDeps = {
    getClient: () => client as unknown as SheetClient,
    getCache: () => cache,
    env: () => '1abcDEF_xyz-1234567890ABCDE',
    configDefault: () => undefined,
    readFile: async () => '',
    readStdin: async () => '',
    print: (s) => {
      output.push(s);
    },
    ...over,
  };
  return { deps, client, output, cache };
}

async function run(args: string[], deps: SheetDeps): Promise<void> {
  const root = new Command();
  root.exitOverride();
  root.addCommand(sheetCommand(deps));
  await root.parseAsync(['node', 'mpu', 'sheet', ...args]);
}

const fakeInfo = {
  spreadsheetId: 'X',
  sheets: [
    {
      properties: {
        title: 'РНП',
        sheetId: 1279867231,
        index: 0,
        gridProperties: { rowCount: 2298, columnCount: 50 },
      },
    },
    {
      properties: {
        title: 'Чек-лист',
        sheetId: 38576503,
        index: 1,
        gridProperties: { rowCount: 101, columnCount: 161 },
      },
    },
  ],
};

describe('sheet ls', () => {
  it('Проверяет: вызывает spreadsheets/get с ssId', async () => {
    const m = makeDeps();
    m.client.do.mockResolvedValueOnce(fakeInfo as never);
    await run(['ls'], m.deps);
    expect(m.client.do).toHaveBeenCalledWith('spreadsheets/get', {
      ssId: '1abcDEF_xyz-1234567890ABCDE',
    });
  });

  it('Проверяет: дефолтный вывод — по одному имени листа на строке', async () => {
    const m = makeDeps();
    m.client.do.mockResolvedValueOnce(fakeInfo as never);
    await run(['ls'], m.deps);
    expect(m.output.join('')).toBe('РНП\nЧек-лист\n');
  });

  it('Проверяет: -l/--long печатает title rows×cols sheetId index', async () => {
    const m = makeDeps();
    m.client.do.mockResolvedValueOnce(fakeInfo as never);
    await run(['ls', '-l'], m.deps);
    const text = m.output.join('');
    expect(text).toMatch(/РНП/);
    expect(text).toMatch(/2298/);
    expect(text).toMatch(/50/);
    expect(text).toMatch(/1279867231/);
    expect(text).toMatch(/Чек-лист/);
    expect(text).toMatch(/161/);
  });

  it('Проверяет: --json печатает массив со standard fields', async () => {
    const m = makeDeps();
    m.client.do.mockResolvedValueOnce(fakeInfo as never);
    await run(['ls', '--json'], m.deps);
    const arr = JSON.parse(m.output.join(''));
    expect(arr).toEqual([
      { title: 'РНП', sheetId: 1279867231, index: 0, rows: 2298, cols: 50 },
      { title: 'Чек-лист', sheetId: 38576503, index: 1, rows: 101, cols: 161 },
    ]);
  });

  it('Проверяет: --spreadsheet перекрывает env', async () => {
    const m = makeDeps();
    m.client.do.mockResolvedValueOnce(fakeInfo as never);
    await run(['ls', '-s', 'OVERRIDE_ID'], m.deps);
    expect(m.client.do.mock.calls[0]![1]).toEqual({ ssId: 'OVERRIDE_ID' });
  });

  it('Проверяет: пустой spreadsheet → пустой вывод (без падения)', async () => {
    const m = makeDeps();
    m.client.do.mockResolvedValueOnce({ spreadsheetId: 'X', sheets: [] } as never);
    await run(['ls'], m.deps);
    expect(m.output.join('')).toBe('');
  });

  it('Проверяет: повторный ls — cache hit, в сеть не ходит', async () => {
    const m = makeDeps();
    m.client.do.mockResolvedValueOnce(fakeInfo as never);
    await run(['ls'], m.deps);
    expect(m.client.do).toHaveBeenCalledTimes(1);

    await run(['ls'], m.deps);
    expect(m.client.do).toHaveBeenCalledTimes(1);
    expect(m.output.filter((s) => s.includes('РНП')).length).toBeGreaterThan(0);
  });

  it('Проверяет: разные ssId — независимые ключи кэша', async () => {
    const m = makeDeps();
    m.client.do.mockResolvedValueOnce(fakeInfo as never);
    m.client.do.mockResolvedValueOnce({
      spreadsheetId: 'Y',
      sheets: [{ properties: { title: 'Other', sheetId: 7, index: 0, gridProperties: { rowCount: 1, columnCount: 1 } } }],
    } as never);
    await run(['ls', '-s', 'ID_AAA'], m.deps);
    await run(['ls', '-s', 'ID_BBB'], m.deps);
    expect(m.client.do).toHaveBeenCalledTimes(2);
  });

  it('Проверяет: --refresh — пропускает чтение кэша, но сохраняет результат', async () => {
    const m = makeDeps();
    m.client.do.mockResolvedValueOnce(fakeInfo as never);
    await run(['ls'], m.deps);
    expect(m.client.do).toHaveBeenCalledTimes(1);

    m.client.do.mockResolvedValueOnce(fakeInfo as never);
    await run(['ls', '--refresh'], m.deps);
    expect(m.client.do).toHaveBeenCalledTimes(2);

    await run(['ls'], m.deps);
    expect(m.client.do).toHaveBeenCalledTimes(2);
  });

  it('Проверяет: -R — короткий алиас для --refresh', async () => {
    const m = makeDeps();
    m.client.do.mockResolvedValueOnce(fakeInfo as never);
    m.client.do.mockResolvedValueOnce(fakeInfo as never);
    await run(['ls'], m.deps);
    await run(['ls', '-R'], m.deps);
    expect(m.client.do).toHaveBeenCalledTimes(2);
  });

  it('Проверяет: cache.ttl=0 — bypass, всегда сеть', async () => {
    const db = openDb(':memory:');
    const config = new Config(db);
    config.set('cache.ttl', 0);
    const cache = new Cache(db, config);
    const m = makeDeps({ getCache: () => cache });
    m.client.do.mockResolvedValue(fakeInfo as never);
    await run(['ls'], m.deps);
    await run(['ls'], m.deps);
    expect(m.client.do).toHaveBeenCalledTimes(2);
  });
});

describe('formatLs', () => {
  const sheets = [
    { title: 'A', sheetId: 1, index: 0, rows: 10, cols: 5 },
    { title: 'Long Name', sheetId: 999_999_999, index: 1, rows: 1, cols: 1 },
  ];

  it('Проверяет: short — имена через \\n с trailing newline', () => {
    expect(formatLs(sheets, { format: 'short' })).toBe('A\nLong Name\n');
  });

  it('Проверяет: long — выровнены колонки', () => {
    const out = formatLs(sheets, { format: 'long' });
    const lines = out.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l).toMatch(/\s+\d+×\d+\s+\d+/);
    }
  });

  it('Проверяет: json — стабильный JSON', () => {
    expect(JSON.parse(formatLs(sheets, { format: 'json' }))).toEqual(sheets);
  });
});
