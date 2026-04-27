import { describe, it, expect, jest } from '@jest/globals';
import { Command } from 'commander';
import { sheetCommand } from '../src/commands/sheet.js';
import type { SheetDeps, SheetClient } from '../src/commands/sheet.js';
import { inspectSpreadsheetSources } from '../src/lib/spreadsheet.js';
import { Cache } from '../src/lib/cache.js';
import { Config } from '../src/lib/config.js';
import { openDb } from '../src/lib/db.js';

type DoFn = <T = unknown>(action: string, payload: Record<string, unknown>) => Promise<T>;

function makeDeps(over: Partial<SheetDeps> = {}): {
  deps: SheetDeps;
  output: string[];
} {
  const doMock = jest.fn<DoFn>();
  const client = { do: doMock };
  const output: string[] = [];
  const db = openDb(':memory:');
  const config = new Config(db);
  const cache = new Cache(db, config);
  const deps: SheetDeps = {
    getClient: () => client as unknown as SheetClient,
    getCache: () => cache,
    env: () => undefined,
    configDefault: () => undefined,
    readFile: async () => '',
    readStdin: async () => '',
    print: (s) => {
      output.push(s);
    },
    ...over,
  };
  return { deps, output };
}

async function run(args: string[], deps: SheetDeps): Promise<void> {
  const root = new Command();
  root.exitOverride();
  root.addCommand(sheetCommand(deps));
  await root.parseAsync(['node', 'mpu', 'sheet', ...args]);
}

describe('inspectSpreadsheetSources', () => {
  it('Проверяет: возвращает все три источника с пометкой used=flag', () => {
    const r = inspectSpreadsheetSources({
      flag: '1abcID',
      env: () => 'envid',
      configDefault: () => 'cfgid',
    });
    expect(r.resolved).toEqual({ id: '1abcID', source: 'flag' });
    expect(r.checked).toEqual([
      { source: 'flag', label: '--spreadsheet/-s', value: '1abcID', used: true },
      { source: 'env', label: 'env MPU_SS', value: 'envid', used: false },
      { source: 'config', label: 'config sheet.default', value: 'cfgid', used: false },
    ]);
  });

  it('Проверяет: пустые источники → resolved=undefined и used везде false', () => {
    const r = inspectSpreadsheetSources({
      flag: undefined,
      env: () => undefined,
      configDefault: () => undefined,
    });
    expect(r.resolved).toBeUndefined();
    for (const c of r.checked) {
      expect(c.used).toBe(false);
      expect(c.value).toBeUndefined();
    }
  });

  it('Проверяет: URL во флаге извлекается в id, но value сохраняет оригинал', () => {
    const url = 'https://docs.google.com/spreadsheets/d/1abc/edit';
    const r = inspectSpreadsheetSources({
      flag: url,
      env: () => undefined,
      configDefault: () => undefined,
    });
    expect(r.resolved).toEqual({ id: '1abc', source: 'flag' });
    expect(r.checked[0]!.value).toBe(url);
  });
});

describe('sheet resolve', () => {
  it('Проверяет: успешное разрешение печатает id и source', async () => {
    const m = makeDeps({ env: () => '1envID_xxxxxxxxxxxxxxxx' });
    await run(['resolve'], m.deps);
    const text = m.output.join('');
    expect(text).toMatch(/1envID_xxxxxxxxxxxxxxxx/);
    expect(text).toMatch(/env MPU_SS/);
  });

  it('Проверяет: --json печатает структурированный объект', async () => {
    const m = makeDeps({ env: () => '1envID' });
    await run(['resolve', '--json'], m.deps);
    const obj = JSON.parse(m.output.join(''));
    expect(obj.resolved).toEqual({ id: '1envID', source: 'env' });
    expect(obj.checked).toHaveLength(3);
    expect(obj.checked[1]).toMatchObject({ source: 'env', used: true });
  });

  it('Проверяет: --spreadsheet перекрывает env и помечает used=flag', async () => {
    const m = makeDeps({ env: () => 'envid', configDefault: () => 'cfgid' });
    await run(['resolve', '-s', 'OVERRIDE_ID', '--json'], m.deps);
    const obj = JSON.parse(m.output.join(''));
    expect(obj.resolved).toEqual({ id: 'OVERRIDE_ID', source: 'flag' });
    expect(obj.checked.find((c: { source: string }) => c.source === 'flag').used).toBe(true);
    expect(obj.checked.find((c: { source: string }) => c.source === 'env').used).toBe(false);
  });

  it('Проверяет: без источников — ошибка с перечислением, exitCode 1', async () => {
    const m = makeDeps();
    let err: Error | undefined;
    try {
      await run(['resolve'], m.deps);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/--spreadsheet/);
    expect(err!.message).toMatch(/MPU_SS/);
    expect(err!.message).toMatch(/sheet\.default/);
  });

  it('Проверяет: --json без источников печатает resolved=null + список checked, без бросания', async () => {
    const m = makeDeps();
    await run(['resolve', '--json'], m.deps);
    const obj = JSON.parse(m.output.join(''));
    expect(obj.resolved).toBeNull();
    expect(obj.checked).toHaveLength(3);
    expect(obj.checked.every((c: { used: boolean }) => c.used === false)).toBe(true);
  });
});
