import type { DB } from './db.js';
import type { SheetClient } from '../commands/sheet.js';
import { parseA1, type A1Range } from './a1.js';

export interface SheetCacheDeps {
  db: DB;
  inner: SheetClient;
  ttlSec: number;
  now?: () => number;
}

interface BatchGetPayload {
  ssId: string;
  ranges: string[];
  majorDimension?: string;
  valueRenderOption?: string;
  dateTimeRenderOption?: string;
}

interface ValueRange {
  range: string;
  values?: unknown[][];
  majorDimension?: string;
}

interface BatchGetResponse {
  spreadsheetId?: string;
  valueRanges?: ValueRange[];
}

type Mode = 'value' | 'formula';

const ACTION_BATCH_GET = 'spreadsheets/values/batchGet';

export class SheetCache implements SheetClient {
  private readonly db: DB;
  private readonly inner: SheetClient;
  private readonly ttlMs: number;
  private readonly now: () => number;

  private readonly selectRect;
  private readonly upsertValue;
  private readonly upsertFormula;

  constructor(deps: SheetCacheDeps) {
    this.db = deps.db;
    this.inner = deps.inner;
    this.ttlMs = deps.ttlSec * 1000;
    this.now = deps.now ?? Date.now;

    this.selectRect = this.db.prepare<
      [string, string, number, number, number, number],
      { row: number; col: number; v_json: string | null; f_text: string | null; fetched_at: number }
    >(
      `SELECT row, col, v_json, f_text, fetched_at
         FROM sheet_cells
        WHERE ss_id = ? AND sheet = ? AND row BETWEEN ? AND ? AND col BETWEEN ? AND ?`,
    );
    this.upsertValue = this.db.prepare(
      `INSERT INTO sheet_cells (ss_id, sheet, row, col, v_json, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(ss_id, sheet, row, col)
         DO UPDATE SET v_json = excluded.v_json, fetched_at = excluded.fetched_at`,
    );
    this.upsertFormula = this.db.prepare(
      `INSERT INTO sheet_cells (ss_id, sheet, row, col, f_text, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(ss_id, sheet, row, col)
         DO UPDATE SET f_text = excluded.f_text, fetched_at = excluded.fetched_at`,
    );
  }

  async do<T = unknown>(action: string, payload: Record<string, unknown>): Promise<T> {
    if (action !== ACTION_BATCH_GET || this.ttlMs === 0) {
      return this.inner.do<T>(action, payload);
    }
    const p = payload as unknown as BatchGetPayload;
    const vro = p.valueRenderOption ?? 'UNFORMATTED_VALUE';
    if (vro === 'FORMATTED_VALUE') {
      return this.inner.do<T>(action, payload);
    }
    const mode: Mode = vro === 'FORMULA' ? 'formula' : 'value';

    const ssId = p.ssId;
    const ranges = p.ranges ?? [];
    const slots: Slot[] = ranges.map((r) => this.classifyRange(ssId, r, mode));

    const missing = slots.filter((s) => s.kind === 'miss' || s.kind === 'bypass');
    if (missing.length === 0) {
      return { spreadsheetId: ssId, valueRanges: slots.map((s) => s.cached!) } as unknown as T;
    }

    const fetchPayload = { ...payload, ranges: missing.map((s) => s.range) };
    const fetched = (await this.inner.do<BatchGetResponse>(action, fetchPayload)) as BatchGetResponse;
    const fetchedRanges = fetched.valueRanges ?? [];

    const now = this.now();
    const valueRanges: ValueRange[] = [];
    let fi = 0;
    for (const slot of slots) {
      if (slot.kind === 'hit') {
        valueRanges.push(slot.cached!);
        continue;
      }
      const got = fetchedRanges[fi++];
      if (!got) throw new Error(`SheetCache: missing fetched range for "${slot.range}"`);
      valueRanges.push({ range: slot.range, majorDimension: 'ROWS', values: got.values });
      if (slot.kind === 'miss') {
        this.storeRect(ssId, slot.parsed!, got.values ?? [], mode, now);
      }
    }

    return { spreadsheetId: ssId, valueRanges } as unknown as T;
  }

  private classifyRange(ssId: string, range: string, mode: Mode): Slot {
    let parsed: A1Range;
    try {
      parsed = parseA1(range);
    } catch {
      return { kind: 'bypass', range };
    }
    if (parsed.wholeSheet) return { kind: 'bypass', range };

    const rows = this.selectRect.all(
      ssId,
      parsed.sheet,
      parsed.r1,
      parsed.r2,
      parsed.c1,
      parsed.c2,
    );
    const area = (parsed.r2 - parsed.r1 + 1) * (parsed.c2 - parsed.c1 + 1);
    if (rows.length !== area) return { kind: 'miss', range, parsed };

    const cutoff = this.now() - this.ttlMs;
    const matrix: unknown[][] = makeMatrix(parsed);
    for (const row of rows) {
      if (row.fetched_at < cutoff) return { kind: 'miss', range, parsed };
      const cell = mode === 'formula' ? row.f_text : row.v_json;
      if (cell === null) return { kind: 'miss', range, parsed };
      const r = row.row - parsed.r1;
      const c = row.col - parsed.c1;
      matrix[r]![c] = mode === 'formula' ? row.f_text : JSON.parse(row.v_json as string);
    }
    return {
      kind: 'hit',
      range,
      parsed,
      cached: { range, majorDimension: 'ROWS', values: matrix },
    };
  }

  private storeRect(
    ssId: string,
    rect: A1Range,
    values: unknown[][],
    mode: Mode,
    now: number,
  ): void {
    const tx = this.db.transaction(() => {
      for (let r = 0; r < values.length; r++) {
        const row = values[r] ?? [];
        for (let c = 0; c < row.length; c++) {
          const cell = row[c];
          if (mode === 'value') {
            this.upsertValue.run(
              ssId,
              rect.sheet,
              rect.r1 + r,
              rect.c1 + c,
              JSON.stringify(cell ?? null),
              now,
            );
          } else {
            this.upsertFormula.run(
              ssId,
              rect.sheet,
              rect.r1 + r,
              rect.c1 + c,
              cell === undefined || cell === null ? '' : String(cell),
              now,
            );
          }
        }
      }
    });
    tx();
  }
}

interface Slot {
  kind: 'hit' | 'miss' | 'bypass';
  range: string;
  parsed?: A1Range;
  cached?: ValueRange;
}

function makeMatrix(rect: A1Range): unknown[][] {
  const rows = rect.r2 - rect.r1 + 1;
  const cols = rect.c2 - rect.c1 + 1;
  const m: unknown[][] = [];
  for (let i = 0; i < rows; i++) m.push(new Array<unknown>(cols).fill(''));
  return m;
}
