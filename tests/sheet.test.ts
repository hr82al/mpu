import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Command } from 'commander';
import { sheetCommand, formatOutput } from '../src/commands/sheet.js';
import type { SheetDeps, SheetClient } from '../src/commands/sheet.js';

type DoFn = <T = unknown>(action: string, payload: Record<string, unknown>) => Promise<T>;

interface FakeClient {
  do: jest.Mock<DoFn>;
}

function makeDeps(over: Partial<SheetDeps> = {}): { deps: SheetDeps; client: FakeClient; output: string[] } {
  const doMock = jest.fn<DoFn>(async () => ({ valueRanges: [] }) as never);
  const client: FakeClient = { do: doMock };
  const output: string[] = [];
  const deps: SheetDeps = {
    getClient: () => client as unknown as SheetClient,
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

  it('Проверяет: позиционный диапазон → batchGet через webapp client', async () => {
    client.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'Sheet1!A1:B2', values: [[1, 2], [3, 4]] }],
    });
    await run(['get', 'Sheet1!A1:B2'], deps);
    expect(client.do).toHaveBeenCalledWith('spreadsheets/values/batchGet', {
      ssId: '1abcDEF_xyz-1234567890ABCDE',
      ranges: ['Sheet1!A1:B2'],
      majorDimension: 'ROWS',
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER',
    });
    const text = output.join('');
    expect(JSON.parse(text)).toEqual({
      spreadsheetId: '1abcDEF_xyz-1234567890ABCDE',
      valueRanges: [{ range: 'Sheet1!A1:B2', values: [[1, 2], [3, 4]] }],
    });
  });

  it('Проверяет: --spreadsheet перекрывает env', async () => {
    client.do.mockResolvedValueOnce({ valueRanges: [] });
    await run(['get', '-s', 'OVERRIDE_ID_xxxxxxxxxxxx', '-n', 'Лист', 'A1'], deps);
    const call = client.do.mock.calls[0]!;
    const payload = call[1] as { ssId: string; ranges: string[] };
    expect(payload.ssId).toBe('OVERRIDE_ID_xxxxxxxxxxxx');
    expect(payload.ranges).toEqual(['Лист!A1']);
  });

  it('Проверяет: --render formulas → FORMULA, --render formatted → FORMATTED_VALUE', async () => {
    client.do.mockResolvedValue({ valueRanges: [] });
    await run(['get', 'A!1', '-n', 'A', '--render', 'formulas'], deps);
    expect(client.do.mock.calls[0]![1]).toMatchObject({ valueRenderOption: 'FORMULA' });
    await run(['get', 'A!1', '-n', 'A', '--render', 'formatted'], deps);
    expect(client.do.mock.calls[1]![1]).toMatchObject({ valueRenderOption: 'FORMATTED_VALUE' });
  });

  it('Проверяет: --raw + одна ячейка → голое значение без перевода строки', async () => {
    const m = makeDeps({ env: () => '1abcDEFxxxxxxxxxxxxxxxx' });
    m.client.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'S!A1', values: [['hello']] }],
    } as never);
    await run(['get', 'S!A1', '--raw'], m.deps);
    expect(m.output.join('')).toBe('hello');
  });

  it('Проверяет: --tsv формирует таб-разделённый вывод', async () => {
    const m = makeDeps({ env: () => '1abcDEFxxxxxxxxxxxxxxxx' });
    m.client.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'S!A1:B2', values: [['a', 'b'], ['c', 'd']] }],
    } as never);
    await run(['get', 'S!A1:B2', '--tsv'], m.deps);
    expect(m.output.join('')).toBe('a\tb\nc\td\n');
  });

  it('Проверяет: --from <file> читает диапазоны из файла', async () => {
    client.do.mockResolvedValueOnce({ valueRanges: [] });
    const m = makeDeps({
      env: () => '1abcDEFxxxxxxxxxxxxxxxx',
      readFile: async (p) => {
        expect(p).toBe('ranges.txt');
        return 'S!A1\nS!B2\n';
      },
    });
    deps = m.deps;
    await run(['get', '--from', 'ranges.txt'], deps);
    const payload = (m.client.do.mock.calls[0]![1] as { ranges: string[] });
    expect(payload.ranges).toEqual(['S!A1', 'S!B2']);
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

describe('formatOutput', () => {
  const ssId = 'X';
  const single = { valueRanges: [{ range: 'S!A1', values: [['v']] }] };
  const matrix = { valueRanges: [{ range: 'S!A1:B2', values: [['a', 'b'], ['c', 'd']] }] };

  it('Проверяет: json — форматированный с ключом spreadsheetId', () => {
    const out = formatOutput(ssId, single, { format: 'json' });
    expect(JSON.parse(out)).toEqual({
      spreadsheetId: 'X',
      valueRanges: single.valueRanges,
    });
  });

  it('Проверяет: raw — одна ячейка возвращает голое значение', () => {
    expect(formatOutput(ssId, single, { format: 'raw' })).toBe('v');
  });

  it('Проверяет: raw — матрица возвращает TSV', () => {
    expect(formatOutput(ssId, matrix, { format: 'raw' })).toBe('a\tb\nc\td\n');
  });

  it('Проверяет: tsv — несколько диапазонов разделяются пустой строкой', () => {
    const multi = {
      valueRanges: [
        { range: 'S!A1', values: [['x']] },
        { range: 'S!B1', values: [['y']] },
      ],
    };
    expect(formatOutput(ssId, multi, { format: 'tsv' })).toBe('x\n\ny\n');
  });
});
