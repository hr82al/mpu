import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Command } from 'commander';
import { sheetCommand, formatCells } from '../src/commands/sheet.js';
import type { SheetDeps, SheetClient } from '../src/commands/sheet.js';
import { Cache } from '../src/lib/cache.js';
import { Config } from '../src/lib/config.js';
import { openDb } from '../src/lib/db.js';

type DoFn = <T = unknown>(
  action: string,
  payload: Record<string, unknown>,
  opts?: { refresh?: boolean },
) => Promise<T>;

interface FakeClient {
  do: jest.Mock<DoFn>;
}

function makeDeps(over: Partial<SheetDeps> = {}): { deps: SheetDeps; client: FakeClient; output: string[] } {
  const doMock = jest.fn<DoFn>(async () => ({ valueRanges: [] }) as never);
  const client: FakeClient = { do: doMock };
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
  return { deps, client, output };
}

async function run(args: string[], deps: SheetDeps): Promise<void> {
  const root = new Command();
  root.exitOverride();
  root.addCommand(sheetCommand(deps));
  await root.parseAsync(['node', 'mpu', 'sheet', ...args]);
}

describe('sheet get', () => {
  let deps: SheetDeps;
  let client: FakeClient;
  let output: string[];

  beforeEach(() => {
    const m = makeDeps({
      env: (k) => (k === 'MPU_SS' ? '1abcDEF_xyz-1234567890ABCDE' : undefined),
    });
    deps = m.deps;
    client = m.client;
    output = m.output;
  });

  it('Проверяет: дефолт + JSON — formula только у реальных формул', async () => {
    client.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'Sheet1!A1:B2', values: [[1, 2], [3, 4]] }],
    } as never);
    client.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'Sheet1!A1:B2', values: [['1', '=A1*2'], ['3', '=A2*2']] }],
    } as never);
    await run(['get', 'Sheet1!A1:B2'], deps);
    expect(client.do).toHaveBeenCalledTimes(2);
    const out = JSON.parse(output.join(''));
    expect(out.cells).toEqual([
      { range: 'Sheet1!A1', value: 1 },
      { range: 'Sheet1!B1', value: 2, formula: '=A1*2' },
      { range: 'Sheet1!A2', value: 3 },
      { range: 'Sheet1!B2', value: 4, formula: '=A2*2' },
    ]);
  });

  it('Проверяет: дефолт + TSV — пустая formula-колонка для не-формулы', async () => {
    const m = makeDeps({ env: () => '1abcDEFxxxxxxxxxxxxxxxx' });
    m.client.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'S!A1:B1', values: [[1, 2]] }],
    } as never);
    m.client.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'S!A1:B1', values: [['1', '=A1*2']] }],
    } as never);
    await run(['get', 'S!A1:B1', '--tsv'], m.deps);
    expect(m.output.join('')).toBe(
      'range\tvalue\tformula\n' +
        'S!A1\t1\t\n' +
        'S!B1\t2\t=A1*2\n',
    );
  });

  it('Проверяет: дефолт + raw — без header, пустая formula для не-формулы', async () => {
    const m = makeDeps({ env: () => '1abcDEFxxxxxxxxxxxxxxxx' });
    m.client.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'S!A1:B1', values: [[1, 2]] }],
    } as never);
    m.client.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'S!A1:B1', values: [['1', '=A1*2']] }],
    } as never);
    await run(['get', 'S!A1:B1', '--raw'], m.deps);
    expect(m.output.join('')).toBe('S!A1\t1\t\nS!B1\t2\t=A1*2\n');
  });

  it('Проверяет: --render values — только value-ключ per cell, 1 batchGet', async () => {
    client.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'S!A1:B1', values: [[5, 6]] }],
    } as never);
    await run(['get', 'S!A1:B1', '--render', 'values'], deps);
    expect(client.do).toHaveBeenCalledTimes(1);
    const out = JSON.parse(output.join(''));
    expect(out.cells).toEqual([
      { range: 'S!A1', value: 5 },
      { range: 'S!B1', value: 6 },
    ]);
  });

  it('Проверяет: --render formulas — formula только у реальных формул, не-формула → только range', async () => {
    client.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'S!A1:B1', values: [['=B1*2', 'plain']] }],
    } as never);
    await run(['get', 'S!A1:B1', '--render', 'formulas'], deps);
    expect(client.do).toHaveBeenCalledTimes(1);
    const out = JSON.parse(output.join(''));
    expect(out.cells).toEqual([
      { range: 'S!A1', formula: '=B1*2' },
      { range: 'S!B1' },
    ]);
  });

  it('Проверяет: --render values + tsv — header range\\tvalue', async () => {
    const m = makeDeps({ env: () => '1abcDEFxxxxxxxxxxxxxxxx' });
    m.client.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'S!A1:B1', values: [[5, 6]] }],
    } as never);
    await run(['get', 'S!A1:B1', '--render', 'values', '--tsv'], m.deps);
    expect(m.output.join('')).toBe('range\tvalue\nS!A1\t5\nS!B1\t6\n');
  });

  it('Проверяет: одна ячейка с формулой — value+formula', async () => {
    client.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'S!A1', values: [[42]] }],
    } as never);
    client.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'S!A1', values: [['=B1*2']] }],
    } as never);
    await run(['get', 'S!A1'], deps);
    const out = JSON.parse(output.join(''));
    expect(out.cells).toEqual([{ range: 'S!A1', value: 42, formula: '=B1*2' }]);
  });

  it('Проверяет: пустые ячейки → только value=null, без formula-ключа', async () => {
    client.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'S!A1:B2', values: [['x']] }],
    } as never);
    client.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'S!A1:B2', values: [['x']] }],
    } as never);
    await run(['get', 'S!A1:B2'], deps);
    const out = JSON.parse(output.join(''));
    expect(out.cells).toEqual([
      { range: 'S!A1', value: 'x' },
      { range: 'S!B1', value: null },
      { range: 'S!A2', value: null },
      { range: 'S!B2', value: null },
    ]);
  });

  it('Проверяет: --spreadsheet перекрывает env (--render values чтобы один запрос)', async () => {
    client.do.mockResolvedValueOnce({ valueRanges: [] } as never);
    await run(['get', '-s', 'OVERRIDE_ID_xxxxxxxxxxxx', '-n', 'Лист', 'A1', '--render', 'values'], deps);
    const call = client.do.mock.calls[0]!;
    const payload = call[1] as { ssId: string; ranges: string[] };
    expect(payload.ssId).toBe('OVERRIDE_ID_xxxxxxxxxxxx');
    expect(payload.ranges).toEqual(['Лист!A1']);
  });

  it('Проверяет: --render formatted → FORMATTED_VALUE', async () => {
    client.do.mockResolvedValueOnce({ valueRanges: [] } as never);
    await run(['get', 'A!1', '-n', 'A', '--render', 'formatted'], deps);
    expect(client.do.mock.calls[0]![1]).toMatchObject({ valueRenderOption: 'FORMATTED_VALUE' });
  });

  it('Проверяет: --raw + --render values + одна ячейка → range\\tvalue', async () => {
    const m = makeDeps({ env: () => '1abcDEFxxxxxxxxxxxxxxxx' });
    m.client.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'S!A1', values: [['hello']] }],
    } as never);
    await run(['get', 'S!A1', '--raw', '--render', 'values'], m.deps);
    expect(m.client.do).toHaveBeenCalledTimes(1);
    expect(m.output.join('')).toBe('S!A1\thello\n');
  });

  it('Проверяет: --tsv + --render values — header + per-cell rows', async () => {
    const m = makeDeps({ env: () => '1abcDEFxxxxxxxxxxxxxxxx' });
    m.client.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'S!A1:B2', values: [['a', 'b'], ['c', 'd']] }],
    } as never);
    await run(['get', 'S!A1:B2', '--tsv', '--render', 'values'], m.deps);
    expect(m.output.join('')).toBe(
      'range\tvalue\n' +
        'S!A1\ta\nS!B1\tb\n' +
        'S!A2\tc\nS!B2\td\n',
    );
  });

  it('Проверяет: --from <file> читает диапазоны из файла', async () => {
    const m = makeDeps({
      env: () => '1abcDEFxxxxxxxxxxxxxxxx',
      readFile: async (p) => {
        expect(p).toBe('ranges.txt');
        return 'S!A1\nS!B2\n';
      },
    });
    m.client.do.mockResolvedValueOnce({ valueRanges: [] } as never);
    await run(['get', '--from', 'ranges.txt', '--render', 'values'], m.deps);
    const payload = m.client.do.mock.calls[0]![1] as { ranges: string[] };
    expect(payload.ranges).toEqual(['S!A1', 'S!B2']);
  });


  it('Проверяет: --refresh передаётся как 3-й параметр в оба batchGet вызова', async () => {
    client.do.mockResolvedValueOnce({ valueRanges: [] } as never);
    client.do.mockResolvedValueOnce({ valueRanges: [] } as never);
    await run(['get', 'Sheet1!A1', '--refresh'], deps);
    expect(client.do.mock.calls[0]![2]).toEqual({ refresh: true });
    expect(client.do.mock.calls[1]![2]).toEqual({ refresh: true });
  });

  it('Проверяет: -R — короткий алиас для --refresh', async () => {
    client.do.mockResolvedValueOnce({ valueRanges: [] } as never);
    client.do.mockResolvedValueOnce({ valueRanges: [] } as never);
    await run(['get', 'Sheet1!A1', '-R'], deps);
    expect(client.do.mock.calls[0]![2]).toEqual({ refresh: true });
  });

  it('Проверяет: без --refresh третий параметр содержит refresh=false', async () => {
    client.do.mockResolvedValueOnce({ valueRanges: [] } as never);
    await run(['get', 'Sheet1!A1', '--render', 'values'], deps);
    expect(client.do.mock.calls[0]![2]).toEqual({ refresh: false });
  });

  it('Проверяет: ошибка отсутствующего spreadsheet — информативное сообщение', async () => {
    const m = makeDeps({ env: () => undefined });
    deps = m.deps;
    let error: Error | undefined;
    try {
      await run(['get', 'S!A1'], deps);
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/--spreadsheet/);
    expect(error!.message).toMatch(/MPU_SS/);
    expect(error!.message).toMatch(/sheet\.default/);
  });
});

describe('formatCells', () => {
  const ssId = 'X';
  const cells = [
    { range: 'S!A1', value: 5, formula: '=2+3' },
    { range: 'S!B1', value: 'hi' },
  ];

  it('Проверяет: json — массив cells, ключи опциональны', () => {
    const out = formatCells(ssId, cells, 'json', ['value', 'formula']);
    expect(JSON.parse(out)).toEqual({ spreadsheetId: 'X', cells });
  });

  it('Проверяет: tsv — header + ровные колонки, пустота если ключ отсутствует', () => {
    expect(formatCells(ssId, cells, 'tsv', ['value', 'formula'])).toBe(
      'range\tvalue\tformula\nS!A1\t5\t=2+3\nS!B1\thi\t\n',
    );
  });

  it('Проверяет: raw — без header', () => {
    expect(formatCells(ssId, cells, 'raw', ['value', 'formula'])).toBe(
      'S!A1\t5\t=2+3\nS!B1\thi\t\n',
    );
  });

  it('Проверяет: tsv с only-value колонкой', () => {
    const onlyV = [{ range: 'S!A1', value: 5 }, { range: 'S!B1', value: 6 }];
    expect(formatCells(ssId, onlyV, 'tsv', ['value'])).toBe(
      'range\tvalue\nS!A1\t5\nS!B1\t6\n',
    );
  });
});
