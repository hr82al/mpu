import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type Database from 'better-sqlite3';
import { openDb } from '../src/lib/db.js';
import { SheetCache } from '../src/lib/sheet-cache.js';
import type { SheetClient } from '../src/commands/sheet.js';

type DoFn = <T = unknown>(action: string, payload: Record<string, unknown>) => Promise<T>;

interface FakeInner {
  do: jest.Mock<DoFn>;
}

function makeInner(): FakeInner {
  return { do: jest.fn<DoFn>() };
}

interface ValueRange {
  range: string;
  values?: unknown[][];
  majorDimension?: string;
}

const ssId = 'SS_X';
const fixedNow = 1_000_000;

describe('SheetCache', () => {
  let db: Database.Database;
  let inner: FakeInner;
  let cache: SheetCache;

  beforeEach(() => {
    db = openDb(':memory:');
    inner = makeInner();
    cache = new SheetCache({
      db,
      inner: inner as unknown as SheetClient,
      ttlSec: 3600,
      now: () => fixedNow,
    });
  });

  it('Проверяет: пустой кэш → запрос идёт через inner и результат сохраняется', async () => {
    inner.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'Sheet1!A1:B2', values: [['a', 'b'], ['c', 'd']] }],
    } as never);
    const r = await cache.do<{ valueRanges: ValueRange[] }>(
      'spreadsheets/values/batchGet',
      {
        ssId,
        ranges: ['Sheet1!A1:B2'],
        valueRenderOption: 'UNFORMATTED_VALUE',
      },
    );
    expect(r.valueRanges[0]!.values).toEqual([['a', 'b'], ['c', 'd']]);
    expect(inner.do).toHaveBeenCalledTimes(1);

    const cnt = db.prepare('SELECT COUNT(*) AS n FROM sheet_cells').get() as { n: number };
    expect(cnt.n).toBe(4);
  });

  it('Проверяет: повторный идентичный запрос — hit, inner не вызывается', async () => {
    inner.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'Sheet1!A1:B2', values: [['a', 'b'], ['c', 'd']] }],
    } as never);
    await cache.do('spreadsheets/values/batchGet', {
      ssId,
      ranges: ['Sheet1!A1:B2'],
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    inner.do.mockClear();

    const r = await cache.do<{ valueRanges: ValueRange[] }>(
      'spreadsheets/values/batchGet',
      { ssId, ranges: ['Sheet1!A1:B2'], valueRenderOption: 'UNFORMATTED_VALUE' },
    );
    expect(inner.do).not.toHaveBeenCalled();
    expect(r.valueRanges[0]!.values).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('Проверяет: подмножество кэшированного диапазона — hit', async () => {
    inner.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'Sheet1!A1:C3', values: [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']] }],
    } as never);
    await cache.do('spreadsheets/values/batchGet', {
      ssId,
      ranges: ['Sheet1!A1:C3'],
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    inner.do.mockClear();

    const r = await cache.do<{ valueRanges: ValueRange[] }>(
      'spreadsheets/values/batchGet',
      { ssId, ranges: ['Sheet1!B2:C3'], valueRenderOption: 'UNFORMATTED_VALUE' },
    );
    expect(inner.do).not.toHaveBeenCalled();
    expect(r.valueRanges[0]!.values).toEqual([['e', 'f'], ['h', 'i']]);
    expect(r.valueRanges[0]!.range).toBe('Sheet1!B2:C3');
  });

  it('Проверяет: диапазон выходит за пределы кэша — miss и поход за всем range', async () => {
    inner.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'Sheet1!A1:B2', values: [['a', 'b'], ['c', 'd']] }],
    } as never);
    await cache.do('spreadsheets/values/batchGet', {
      ssId,
      ranges: ['Sheet1!A1:B2'],
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    inner.do.mockClear();
    inner.do.mockResolvedValueOnce({
      valueRanges: [
        { range: 'Sheet1!A1:C3', values: [['a', 'b', 'x'], ['c', 'd', 'y'], ['z', 'w', 'q']] },
      ],
    } as never);

    const r = await cache.do<{ valueRanges: ValueRange[] }>(
      'spreadsheets/values/batchGet',
      { ssId, ranges: ['Sheet1!A1:C3'], valueRenderOption: 'UNFORMATTED_VALUE' },
    );
    expect(inner.do).toHaveBeenCalledTimes(1);
    expect(r.valueRanges[0]!.values).toEqual([
      ['a', 'b', 'x'],
      ['c', 'd', 'y'],
      ['z', 'w', 'q'],
    ]);
  });

  it('Проверяет: TTL истёк → cache miss', async () => {
    inner.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'Sheet1!A1', values: [['v']] }],
    } as never);
    await cache.do('spreadsheets/values/batchGet', {
      ssId,
      ranges: ['Sheet1!A1'],
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    inner.do.mockClear();

    const expired = new SheetCache({
      db,
      inner: inner as unknown as SheetClient,
      ttlSec: 60,
      now: () => fixedNow + 120 * 1000,
    });
    inner.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'Sheet1!A1', values: [['v2']] }],
    } as never);
    const r = await expired.do<{ valueRanges: ValueRange[] }>(
      'spreadsheets/values/batchGet',
      { ssId, ranges: ['Sheet1!A1'], valueRenderOption: 'UNFORMATTED_VALUE' },
    );
    expect(inner.do).toHaveBeenCalledTimes(1);
    expect(r.valueRanges[0]!.values).toEqual([['v2']]);
  });

  it('Проверяет: ttlSec=0 → bypass, ничего не сохраняется', async () => {
    const off = new SheetCache({
      db,
      inner: inner as unknown as SheetClient,
      ttlSec: 0,
      now: () => fixedNow,
    });
    inner.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'Sheet1!A1', values: [['v']] }],
    } as never);
    const r = await off.do<{ valueRanges: ValueRange[] }>(
      'spreadsheets/values/batchGet',
      { ssId, ranges: ['Sheet1!A1'], valueRenderOption: 'UNFORMATTED_VALUE' },
    );
    expect(r.valueRanges[0]!.values).toEqual([['v']]);
    const cnt = db.prepare('SELECT COUNT(*) AS n FROM sheet_cells').get() as { n: number };
    expect(cnt.n).toBe(0);
  });

  it('Проверяет: FORMATTED_VALUE bypass — ничего не сохраняется и не читается', async () => {
    inner.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'Sheet1!A1', values: [['100,5 ₽']] }],
    } as never);
    await cache.do('spreadsheets/values/batchGet', {
      ssId,
      ranges: ['Sheet1!A1'],
      valueRenderOption: 'FORMATTED_VALUE',
    });
    const cnt = db.prepare('SELECT COUNT(*) AS n FROM sheet_cells').get() as { n: number };
    expect(cnt.n).toBe(0);
  });

  it('Проверяет: whole-sheet range (Sheet1) — bypass, нечего склеивать', async () => {
    inner.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'Sheet1', values: [['a']] }],
    } as never);
    await cache.do('spreadsheets/values/batchGet', {
      ssId,
      ranges: ['Sheet1'],
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    expect(inner.do).toHaveBeenCalledTimes(1);
    const cnt = db.prepare('SELECT COUNT(*) AS n FROM sheet_cells').get() as { n: number };
    expect(cnt.n).toBe(0);
  });

  it('Проверяет: смешанный batch — часть hit, часть miss; запрос только misses', async () => {
    inner.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'Sheet1!A1:B2', values: [['a', 'b'], ['c', 'd']] }],
    } as never);
    await cache.do('spreadsheets/values/batchGet', {
      ssId,
      ranges: ['Sheet1!A1:B2'],
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    inner.do.mockClear();
    inner.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'Sheet2!C3', values: [['z']] }],
    } as never);

    const r = await cache.do<{ valueRanges: ValueRange[] }>(
      'spreadsheets/values/batchGet',
      {
        ssId,
        ranges: ['Sheet1!A1:B2', 'Sheet2!C3'],
        valueRenderOption: 'UNFORMATTED_VALUE',
      },
    );
    expect(inner.do).toHaveBeenCalledTimes(1);
    const sentRanges = (inner.do.mock.calls[0]![1] as { ranges: string[] }).ranges;
    expect(sentRanges).toEqual(['Sheet2!C3']);
    expect(r.valueRanges).toHaveLength(2);
    expect(r.valueRanges[0]!.range).toBe('Sheet1!A1:B2');
    expect(r.valueRanges[0]!.values).toEqual([['a', 'b'], ['c', 'd']]);
    expect(r.valueRanges[1]!.range).toBe('Sheet2!C3');
    expect(r.valueRanges[1]!.values).toEqual([['z']]);
  });

  it('Проверяет: FORMULA mode — отдает f_text если есть, иначе value', async () => {
    inner.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'S!A1:B1', values: [['1', '=A1*2']] }],
    } as never);
    await cache.do('spreadsheets/values/batchGet', {
      ssId,
      ranges: ['S!A1:B1'],
      valueRenderOption: 'FORMULA',
    });
    inner.do.mockClear();
    const r = await cache.do<{ valueRanges: ValueRange[] }>(
      'spreadsheets/values/batchGet',
      { ssId, ranges: ['S!A1:B1'], valueRenderOption: 'FORMULA' },
    );
    expect(inner.do).not.toHaveBeenCalled();
    expect(r.valueRanges[0]!.values).toEqual([['1', '=A1*2']]);
  });

  it('Проверяет: усечённый ответ Apps Script всё равно полностью кэширует rect', async () => {
    inner.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'Sheet1!A1:C5', values: [['x'], ['a', 'b', 'c']] }],
    } as never);
    await cache.do('spreadsheets/values/batchGet', {
      ssId,
      ranges: ['Sheet1!A1:C5'],
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const cnt = db.prepare('SELECT COUNT(*) AS n FROM sheet_cells').get() as { n: number };
    expect(cnt.n).toBe(15);

    inner.do.mockClear();
    const r = await cache.do<{ valueRanges: ValueRange[] }>(
      'spreadsheets/values/batchGet',
      { ssId, ranges: ['Sheet1!A1:C5'], valueRenderOption: 'UNFORMATTED_VALUE' },
    );
    expect(inner.do).not.toHaveBeenCalled();
    expect(r.valueRanges[0]!.values).toEqual([
      ['x', null, null],
      ['a', 'b', 'c'],
      [null, null, null],
      [null, null, null],
      [null, null, null],
    ]);

    const r2 = await cache.do<{ valueRanges: ValueRange[] }>(
      'spreadsheets/values/batchGet',
      { ssId, ranges: ['Sheet1!B2:C3'], valueRenderOption: 'UNFORMATTED_VALUE' },
    );
    expect(inner.do).not.toHaveBeenCalled();
    expect(r2.valueRanges[0]!.values).toEqual([
      ['b', 'c'],
      [null, null],
    ]);
  });

  it('Проверяет: refresh=true — все диапазоны идут в сеть, кэш перезаписывается', async () => {
    inner.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'Sheet1!A1:B1', values: [['a', 'b']] }],
    } as never);
    await cache.do('spreadsheets/values/batchGet', {
      ssId,
      ranges: ['Sheet1!A1:B1'],
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    inner.do.mockClear();
    inner.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'Sheet1!A1:B1', values: [['x', 'y']] }],
    } as never);

    const r = await cache.do<{ valueRanges: ValueRange[] }>(
      'spreadsheets/values/batchGet',
      { ssId, ranges: ['Sheet1!A1:B1'], valueRenderOption: 'UNFORMATTED_VALUE' },
      { refresh: true },
    );
    expect(inner.do).toHaveBeenCalledTimes(1);
    const sentRanges = (inner.do.mock.calls[0]![1] as { ranges: string[] }).ranges;
    expect(sentRanges).toEqual(['Sheet1!A1:B1']);
    expect(r.valueRanges[0]!.values).toEqual([['x', 'y']]);

    inner.do.mockClear();
    const r2 = await cache.do<{ valueRanges: ValueRange[] }>(
      'spreadsheets/values/batchGet',
      { ssId, ranges: ['Sheet1!A1:B1'], valueRenderOption: 'UNFORMATTED_VALUE' },
    );
    expect(inner.do).not.toHaveBeenCalled();
    expect(r2.valueRanges[0]!.values).toEqual([['x', 'y']]);
  });

  it('Проверяет: некэшируемое action делегирует в inner без сохранения', async () => {
    inner.do.mockResolvedValueOnce({ ok: true } as never);
    const r = await cache.do<{ ok: boolean }>('spreadsheets/some-other-action', {
      ssId,
      data: [],
    });
    expect(r).toEqual({ ok: true });
    const cnt = db.prepare('SELECT COUNT(*) AS n FROM sheet_cells').get() as { n: number };
    expect(cnt.n).toBe(0);
  });

  it('Проверяет: batchUpdate инвалидирует затронутые ячейки в кэше', async () => {
    inner.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'Sheet1!A1:C3', values: [['a','b','c'],['d','e','f'],['g','h','i']] }],
    } as never);
    await cache.do('spreadsheets/values/batchGet', {
      ssId,
      ranges: ['Sheet1!A1:C3'],
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sheet_cells').get()).toEqual({ n: 9 });

    inner.do.mockResolvedValueOnce({
      spreadsheetId: ssId,
      responses: [{ updatedRange: 'Sheet1!B2:C3', updatedCells: 4 }],
    } as never);
    await cache.do('spreadsheets/values/batchUpdate', {
      ssId,
      data: [{ range: 'Sheet1!B2:C3', values: [['X','Y'],['Z','W']] }],
    });
    const remaining = db.prepare('SELECT row, col FROM sheet_cells ORDER BY row, col').all() as Array<{ row: number; col: number }>;
    expect(remaining).toEqual([
      { row: 1, col: 1 }, { row: 1, col: 2 }, { row: 1, col: 3 },
      { row: 2, col: 1 },
      { row: 3, col: 1 },
    ]);
  });

  it('Проверяет: batchUpdate без успеха (исключение) — кэш не трогается', async () => {
    inner.do.mockResolvedValueOnce({
      valueRanges: [{ range: 'Sheet1!A1', values: [['v']] }],
    } as never);
    await cache.do('spreadsheets/values/batchGet', {
      ssId, ranges: ['Sheet1!A1'], valueRenderOption: 'UNFORMATTED_VALUE',
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sheet_cells').get()).toEqual({ n: 1 });

    inner.do.mockRejectedValueOnce(new Error('boom') as never);
    await expect(
      cache.do('spreadsheets/values/batchUpdate', {
        ssId, data: [{ range: 'Sheet1!A1', values: [['X']] }],
      }),
    ).rejects.toThrow(/boom/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sheet_cells').get()).toEqual({ n: 1 });
  });
});
