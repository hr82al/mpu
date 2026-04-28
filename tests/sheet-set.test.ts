import { describe, it, expect, jest } from '@jest/globals';
import { Command } from 'commander';
import { sheetCommand, parseUpdates } from '../src/commands/sheet.js';
import type { SheetDeps, SheetClient } from '../src/commands/sheet.js';
import { Cache } from '../src/lib/cache.js';
import { Config } from '../src/lib/config.js';
import { openDb } from '../src/lib/db.js';
import { SheetAliases } from '../src/lib/sheet-aliases.js';
import { SlSpreadsheets } from '../src/lib/sl-spreadsheets.js';

type DoFn = <T = unknown>(action: string, payload: Record<string, unknown>) => Promise<T>;

function makeDeps(over: Partial<SheetDeps> = {}, configOver?: (c: Config) => void): {
  deps: SheetDeps;
  client: { do: jest.Mock<DoFn> };
  output: string[];
  config: Config;
} {
  const doMock = jest.fn<DoFn>();
  const client = { do: doMock };
  const output: string[] = [];
  const db = openDb(':memory:');
  const config = new Config(db);
  if (configOver) configOver(config);
  const cache = new Cache(db, config);
  const deps: SheetDeps = {
    getClient: () => client as unknown as SheetClient,
    getCache: () => cache,
    getAliases: () => new SheetAliases(db),
    env: () => '1abcDEF_xyz-1234567890ABCDE',
    configDefault: () => undefined,
    isProtected: () => (config.get('sheet.protected') as boolean),
    getSlStore: () => new SlSpreadsheets(db),
    buildSlApi: () => { throw new Error('SlApi not configured in tests'); },
    readFile: async () => '',
    readStdin: async () => '',
    print: (s) => {
      output.push(s);
    },
    openUrl: async () => {},
    ...over,
  };
  return { deps, client, output, config };
}

async function run(args: string[], deps: SheetDeps): Promise<void> {
  const root = new Command();
  root.exitOverride();
  root.addCommand(sheetCommand(deps));
  await root.parseAsync(['node', 'mpu', 'sheet', ...args]);
}

describe('sheet set', () => {
  it('Проверяет: protected (default) без --force — ошибка', async () => {
    const m = makeDeps();
    let err: Error | undefined;
    try {
      await run(['set', 'S!A1', 'hello'], m.deps);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/protected/i);
    expect(err!.message).toMatch(/--force/);
    expect(m.client.do).not.toHaveBeenCalled();
  });

  it('Проверяет: protected + --force → batchUpdate с USER_ENTERED (Apps Script shape)', async () => {
    const m = makeDeps();
    m.client.do.mockResolvedValueOnce({
      spreadsheetId: '1abcDEF_xyz-1234567890ABCDE',
      responses: [{ updatedRange: 'S!A1', updatedCells: 1 }],
    } as never);
    await run(['set', 'S!A1', 'hello', '--force'], m.deps);
    expect(m.client.do).toHaveBeenCalledWith('spreadsheets/values/batchUpdate', {
      ssId: '1abcDEF_xyz-1234567890ABCDE',
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [{ range: 'S!A1', values: [['hello']] }],
      },
    });
  });

  it('Проверяет: -f — короткий алиас --force', async () => {
    const m = makeDeps();
    m.client.do.mockResolvedValueOnce({ responses: [] } as never);
    await run(['set', 'S!A1', 'x', '-f'], m.deps);
    expect(m.client.do).toHaveBeenCalledTimes(1);
  });

  it('Проверяет: sheet.protected=false → --force не нужен', async () => {
    const m = makeDeps({}, (c) => c.set('sheet.protected', false));
    m.client.do.mockResolvedValueOnce({ responses: [] } as never);
    await run(['set', 'S!A1', 'x'], m.deps);
    expect(m.client.do).toHaveBeenCalledTimes(1);
  });

  it('Проверяет: --literal/-l → valueInputOption=RAW', async () => {
    const m = makeDeps();
    m.client.do.mockResolvedValueOnce({ responses: [] } as never);
    await run(['set', 'S!A1', '=A2*2', '-f', '--literal'], m.deps);
    expect(m.client.do.mock.calls[0]![1]).toMatchObject({
      requestBody: { valueInputOption: 'RAW' },
    });
  });

  it('Проверяет: --from <file> читает batch range\\tvalue', async () => {
    const m = makeDeps({
      readFile: async (p) => {
        expect(p).toBe('updates.tsv');
        return ['# header', '', 'S!A1\thello', 'S!B2\t=A1*2'].join('\n');
      },
    });
    m.client.do.mockResolvedValueOnce({ responses: [] } as never);
    await run(['set', '--from', 'updates.tsv', '-f'], m.deps);
    expect(m.client.do.mock.calls[0]![1]).toMatchObject({
      requestBody: {
        data: [
          { range: 'S!A1', values: [['hello']] },
          { range: 'S!B2', values: [['=A1*2']] },
        ],
      },
    });
  });

  it('Проверяет: --from - читает stdin', async () => {
    const m = makeDeps({ readStdin: async () => 'S!A1\thi' });
    m.client.do.mockResolvedValueOnce({ responses: [] } as never);
    await run(['set', '--from', '-', '-f'], m.deps);
    expect(m.client.do.mock.calls[0]![1]).toMatchObject({
      requestBody: {
        data: [{ range: 'S!A1', values: [['hi']] }],
      },
    });
  });

  it('Проверяет: позиционные без range/value и без --from — ошибка', async () => {
    const m = makeDeps();
    let err: Error | undefined;
    try {
      await run(['set', '-f'], m.deps);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/range/i);
  });

  it('Проверяет: JSON-вывод по умолчанию', async () => {
    const m = makeDeps();
    m.client.do.mockResolvedValueOnce({
      spreadsheetId: '1abc',
      responses: [{ updatedRange: 'S!A1', updatedCells: 1 }],
    } as never);
    await run(['set', 'S!A1', 'hi', '-f'], m.deps);
    const out = JSON.parse(m.output.join(''));
    expect(out).toEqual({
      spreadsheetId: '1abc',
      updates: [{ range: 'S!A1', updatedCells: 1 }],
    });
  });
});

describe('parseUpdates', () => {
  it('Проверяет: парсит range\\tvalue per line, игнорирует # и пустые', () => {
    const text = ['# comment', '', 'S!A1\thello', '  S!B2\t=A1*2  ', '#skip', 'S!C3\tabc'].join('\n');
    expect(parseUpdates(text)).toEqual([
      { range: 'S!A1', value: 'hello' },
      { range: 'S!B2', value: '=A1*2' },
      { range: 'S!C3', value: 'abc' },
    ]);
  });

  it('Проверяет: unescape \\n \\t \\\\ в значении', () => {
    expect(parseUpdates('S!A1\tline1\\nline2\\ttab\\\\back')).toEqual([
      { range: 'S!A1', value: 'line1\nline2\ttab\\back' },
    ]);
  });

  it('Проверяет: строка без \\t — ошибка с указанием номера', () => {
    expect(() => parseUpdates('S!A1\thi\nbroken-no-tab')).toThrow(/line 2/);
  });
});
