import { describe, it, expect, jest } from '@jest/globals';
import { Command } from 'commander';
import { sheetCommand, buildSpreadsheetUrl } from '../src/commands/sheet.js';
import type { SheetDeps, SheetClient } from '../src/commands/sheet.js';
import { Cache } from '../src/lib/cache.js';
import { Config } from '../src/lib/config.js';
import { openDb } from '../src/lib/db.js';
import { SheetAliases } from '../src/lib/sheet-aliases.js';
import { SlSpreadsheets } from '../src/lib/sl-spreadsheets.js';

type DoFn = <T = unknown>(action: string, payload: Record<string, unknown>) => Promise<T>;

function makeDeps(over: Partial<SheetDeps> = {}): {
  deps: SheetDeps;
  client: { do: jest.Mock<DoFn> };
  output: string[];
  opened: string[];
} {
  const doMock = jest.fn<DoFn>();
  const client = { do: doMock };
  const output: string[] = [];
  const opened: string[] = [];
  const db = openDb(':memory:');
  const config = new Config(db);
  const cache = new Cache(db, config);
  const deps: SheetDeps = {
    getClient: () => client as unknown as SheetClient,
    getCache: () => cache,
    getAliases: () => new SheetAliases(db),
    isProtected: () => true,
    getSlStore: () => new SlSpreadsheets(db),
    buildSlApi: () => { throw new Error('SlApi not configured in tests'); },
    env: () => '1abcDEF_xyz-1234567890ABCDE',
    configDefault: () => undefined,
    readFile: async () => '',
    readStdin: async () => '',
    print: (s) => {
      output.push(s);
    },
    openUrl: async (url) => {
      opened.push(url);
    },
    ...over,
  };
  return { deps, client, output, opened };
}

async function run(args: string[], deps: SheetDeps): Promise<void> {
  const root = new Command();
  root.exitOverride();
  root.addCommand(sheetCommand(deps));
  await root.parseAsync(['node', 'mpu', 'sheet', ...args]);
}

const fakeInfo = {
  spreadsheetId: '1abcDEF_xyz-1234567890ABCDE',
  sheets: [
    { properties: { title: 'РНП', sheetId: 1279867231, index: 0, gridProperties: { rowCount: 10, columnCount: 5 } } },
    { properties: { title: 'UNIT', sheetId: 395952693, index: 3, gridProperties: { rowCount: 10, columnCount: 5 } } },
  ],
};

describe('buildSpreadsheetUrl', () => {
  it('Проверяет: без gid — базовый URL', () => {
    expect(buildSpreadsheetUrl('1abc')).toBe(
      'https://docs.google.com/spreadsheets/d/1abc/edit',
    );
  });

  it('Проверяет: с gid — добавляет #gid=N', () => {
    expect(buildSpreadsheetUrl('1abc', 12345)).toBe(
      'https://docs.google.com/spreadsheets/d/1abc/edit#gid=12345',
    );
  });
});

describe('sheet open', () => {
  it('Проверяет: без аргументов — открывает spreadsheet без gid', async () => {
    const m = makeDeps();
    await run(['open'], m.deps);
    expect(m.opened).toEqual([
      'https://docs.google.com/spreadsheets/d/1abcDEF_xyz-1234567890ABCDE/edit',
    ]);
    expect(m.client.do).not.toHaveBeenCalled();
  });

  it('Проверяет: c именем листа — резолвит gid через spreadsheets/get', async () => {
    const m = makeDeps();
    m.client.do.mockResolvedValueOnce(fakeInfo as never);
    await run(['open', 'UNIT'], m.deps);
    expect(m.opened).toEqual([
      'https://docs.google.com/spreadsheets/d/1abcDEF_xyz-1234567890ABCDE/edit#gid=395952693',
    ]);
    expect(m.client.do).toHaveBeenCalledWith('spreadsheets/get', {
      ssId: '1abcDEF_xyz-1234567890ABCDE',
    });
  });

  it('Проверяет: --print — печатает URL вместо открытия', async () => {
    const m = makeDeps();
    await run(['open', '--print'], m.deps);
    expect(m.opened).toEqual([]);
    expect(m.output.join('').trim()).toBe(
      'https://docs.google.com/spreadsheets/d/1abcDEF_xyz-1234567890ABCDE/edit',
    );
  });

  it('Проверяет: неизвестный лист — ошибка с перечислением доступных', async () => {
    const m = makeDeps();
    m.client.do.mockResolvedValueOnce(fakeInfo as never);
    let err: Error | undefined;
    try {
      await run(['open', 'NoSuch'], m.deps);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/NoSuch/);
    expect(err!.message).toMatch(/РНП/);
    expect(err!.message).toMatch(/UNIT/);
  });

  it('Проверяет: --spreadsheet перекрывает env', async () => {
    const m = makeDeps();
    await run(['open', '-s', 'OVERRIDE', '--print'], m.deps);
    expect(m.output.join('').trim()).toBe(
      'https://docs.google.com/spreadsheets/d/OVERRIDE/edit',
    );
  });
});
