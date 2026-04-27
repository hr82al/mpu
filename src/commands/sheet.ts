import { Command } from 'commander';
import { readFile as fsReadFile } from 'node:fs/promises';
import { describe } from '../lib/help.js';
import { setProvider } from '../lib/completion.js';
import {
  inspectSpreadsheetSources,
  resolveRanges,
  resolveSpreadsheetId,
  type SpreadsheetInspection,
} from '../lib/spreadsheet.js';
import { WebappClient } from '../lib/webapp.js';
import { envLookup } from '../lib/env.js';
import { getDefaultConfig } from '../lib/config.js';
import type { Config } from '../lib/config.js';
import { getDefaultDb } from '../lib/db.js';
import { SheetCache } from '../lib/sheet-cache.js';
import { Cache, getDefaultCache } from '../lib/cache.js';
import { MAIN_BIN } from '../lib/branding.js';
import { parseA1, colNumToA1, A1ParseError } from '../lib/a1.js';

export interface BatchGetResult {
  valueRanges: Array<{ range: string; values?: unknown[][]; majorDimension?: string }>;
}

export interface SheetCallOptions {
  /**
   * Пропустить чтение из кэша (если он есть), но всё равно сохранить результат.
   */
  refresh?: boolean;
}

export interface SheetClient {
  do: <T = unknown>(
    action: string,
    payload: Record<string, unknown>,
    opts?: SheetCallOptions,
  ) => Promise<T>;
}

export interface SheetDeps {
  getClient: () => SheetClient;
  getCache: () => Cache;
  env: (key: string) => string | undefined;
  configDefault: () => string | undefined;
  readFile: (path: string) => Promise<string>;
  readStdin: () => Promise<string>;
  print: (text: string) => void;
}

const RENDER_MAP: Record<string, string> = {
  values: 'UNFORMATTED_VALUE',
  formulas: 'FORMULA',
  formatted: 'FORMATTED_VALUE',
};

type RenderMode = 'both' | 'values' | 'formulas' | 'formatted';
const VALID_RENDER: ReadonlyArray<RenderMode> = ['both', 'values', 'formulas', 'formatted'];

export type OutputFormat = 'json' | 'raw' | 'tsv';

export function sheetCommand(deps: SheetDeps = defaultDeps()): Command {
  const cmd = new Command('sheet');
  describe(cmd, {
    summary: 'Read and write Google Spreadsheets via Apps Script',
    description:
      'Read and write Google Spreadsheets via the Apps Script webapp. ' +
      'Spreadsheet ID is resolved from --spreadsheet, then env MPU_SS, then config sheet.default.',
  });

  const get = new Command('get');
  describe(get, {
    summary: 'Read cell values from one or more A1 ranges',
    description: [
      'Read cell values from one or more A1-notation ranges.',
      '',
      'Spreadsheet resolution order: --spreadsheet/-s → env MPU_SS → config sheet.default.',
      'Range sources can be combined: positional args, --sheet/-n + bare ranges, --from <file|->.',
    ].join('\n'),
    examples: [
      { cmd: "sheet get 'Sheet1!A1:B2'", note: 'single range, ID from MPU_SS or config' },
      { cmd: "sheet get -n Лист A1:B5 C1:D2", note: '--sheet adds prefix to bare ranges' },
      { cmd: 'sheet get -s 1abc... "Sheet1!A1" "Sheet2!C3"', note: 'multiple ranges' },
      { cmd: 'sheet get --from ranges.txt', note: 'one range per line, # comments' },
      { cmd: 'echo "S!A1" | sheet get --from -', note: 'stdin' },
      { cmd: "sheet get 'S!A1' --raw", note: 'bare value (single cell)' },
      { cmd: "sheet get 'S!A1:C3' --tsv", note: 'TSV output' },
      { cmd: "sheet get 'S!A1'", note: 'default: both values and formulas (cached)' },
      { cmd: "sheet get 'S!A1' --render values", note: 'only values, single batchGet' },
      { cmd: "sheet get 'S!A1' --render formulas", note: 'only formulas (FORMULA mode)' },
      { cmd: "sheet get 'S!A1' --render formatted", note: 'locale-formatted display values' },
    ],
  });

  setProvider(get, ({ args }) => {
    if (args.length === 0) return [];
    return [];
  });

  get
    .argument('[ranges...]', 'A1-notation ranges, with or without sheet prefix')
    .option('-s, --spreadsheet <id-or-url>', 'spreadsheet ID or full Google Sheets URL')
    .option('-n, --sheet <name>', 'default sheet name for ranges without prefix')
    .option('--from <file>', 'read ranges from file (one per line, # comments). Use - for stdin')
    .option(
      '--render <mode>',
      'render mode: both (default — values + formulas) | values | formulas | formatted',
      'both',
    )
    .option('--json', 'output structured JSON (default)')
    .option('--raw', 'bare values; single cell prints without trailing newline')
    .option('--tsv', 'TSV output (tab-separated, range-separated by blank line)')
    .option(
      '-R, --refresh',
      'skip cache lookup, fetch fresh from network and overwrite cache',
    )
    .action(
      async (
        positional: string[],
        opts: {
          spreadsheet?: string;
          sheet?: string;
          from?: string;
          render: string;
          json?: boolean;
          raw?: boolean;
          tsv?: boolean;
          refresh?: boolean;
        },
      ) => {
        const render = opts.render as RenderMode;
        if (!VALID_RENDER.includes(render)) {
          throw new Error(
            `unknown --render value "${opts.render}". Valid: ${VALID_RENDER.join(' | ')}`,
          );
        }
        const formats = [opts.json, opts.raw, opts.tsv].filter(Boolean).length;
        if (formats > 1) {
          throw new Error('only one of --json / --raw / --tsv can be set');
        }
        const format: OutputFormat = opts.raw ? 'raw' : opts.tsv ? 'tsv' : 'json';

        const { id: ssId } = resolveSpreadsheetId({
          flag: opts.spreadsheet,
          env: () => deps.env('MPU_SS'),
          configDefault: deps.configDefault,
        });
        const ranges = await resolveRanges({
          positional,
          sheet: opts.sheet,
          from: opts.from,
          readFile: deps.readFile,
          readStdin: deps.readStdin,
        });

        const client = deps.getClient();
        const fetchOne = (vro: string): Promise<BatchGetResult> =>
          client.do<BatchGetResult>(
            'spreadsheets/values/batchGet',
            {
              ssId,
              ranges,
              majorDimension: 'ROWS',
              valueRenderOption: vro,
              dateTimeRenderOption: 'SERIAL_NUMBER',
            },
            { refresh: !!opts.refresh },
          );

        let valuesResult: BatchGetResult | undefined;
        let formulasResult: BatchGetResult | undefined;
        if (render === 'both') {
          [valuesResult, formulasResult] = await Promise.all([
            fetchOne('UNFORMATTED_VALUE'),
            fetchOne('FORMULA'),
          ]);
        } else if (render === 'formulas') {
          formulasResult = await fetchOne('FORMULA');
        } else {
          valuesResult = await fetchOne(RENDER_MAP[render]!);
        }

        const cells = expandCells(valuesResult, formulasResult, render);
        deps.print(formatCells(ssId, cells, format, columnsForRender(render)));
      },
    );

  cmd.addCommand(get);
  cmd.addCommand(resolveSubcommand(deps));
  cmd.addCommand(lsSubcommand(deps));
  return cmd;
}

interface SheetSummary {
  title: string;
  sheetId: number;
  index: number;
  rows: number;
  cols: number;
}

interface SheetEntry {
  properties?: {
    title?: string;
    sheetId?: number;
    index?: number;
    gridProperties?: { rowCount?: number; columnCount?: number };
  };
}

interface SpreadsheetsGetResponse {
  spreadsheetId: string;
  sheets?: SheetEntry[];
}

function lsSubcommand(deps: SheetDeps): Command {
  const cmd = new Command('ls');
  describe(cmd, {
    summary: 'List sheets in a spreadsheet',
    description: [
      'List sheet (tab) names in a Google Spreadsheet.',
      '',
      'Default output: one title per line (Unix-style, pipe-friendly).',
      'Spreadsheet resolution: --spreadsheet/-s → env MPU_SS → config sheet.default.',
    ].join('\n'),
    examples: [
      { cmd: 'sheet ls', note: 'just the names, one per line' },
      { cmd: 'sheet ls -l', note: 'long: title, rows×cols, sheetId, index' },
      { cmd: 'sheet ls --json', note: 'structured array (for AI/scripts)' },
      { cmd: 'sheet ls -s 1abc...', note: 'specific spreadsheet' },
      { cmd: 'sheet ls | grep -i план', note: 'pipe to grep' },
    ],
  });
  cmd
    .option('-s, --spreadsheet <id-or-url>', 'spreadsheet ID or full Google Sheets URL')
    .option('-l, --long', 'detailed output: title, rows×cols, sheetId, index')
    .option('--json', 'structured JSON array')
    .option(
      '-R, --refresh',
      'skip cache lookup, fetch fresh from network and overwrite cache',
    )
    .action(
      async (opts: { spreadsheet?: string; long?: boolean; json?: boolean; refresh?: boolean }) => {
        if (opts.long && opts.json) throw new Error('only one of --long / --json can be set');
        const format: LsFormat = opts.json ? 'json' : opts.long ? 'long' : 'short';
        const { id: ssId } = resolveSpreadsheetId({
          flag: opts.spreadsheet,
          env: () => deps.env('MPU_SS'),
          configDefault: deps.configDefault,
        });
        const client = deps.getClient();
        const cache = deps.getCache();
        const result = await cache.wrapAsync(
          `sheet:info:${ssId}`,
          () => client.do<SpreadsheetsGetResponse>('spreadsheets/get', { ssId }),
          { refresh: !!opts.refresh },
        );
        const sheets = (result.sheets ?? []).map(toSheetSummary);
        deps.print(formatLs(sheets, { format }));
      },
    );
  return cmd;
}

function toSheetSummary(s: SheetEntry): SheetSummary {
  const p = s.properties ?? {};
  const g = p.gridProperties ?? {};
  return {
    title: p.title ?? '',
    sheetId: p.sheetId ?? 0,
    index: p.index ?? 0,
    rows: g.rowCount ?? 0,
    cols: g.columnCount ?? 0,
  };
}

export type LsFormat = 'short' | 'long' | 'json';

export function formatLs(sheets: SheetSummary[], opts: { format: LsFormat }): string {
  if (sheets.length === 0) return '';
  switch (opts.format) {
    case 'short':
      return sheets.map((s) => s.title).join('\n') + '\n';
    case 'json':
      return JSON.stringify(sheets, null, 2);
    case 'long': {
      const titleW = Math.max(...sheets.map((s) => visualWidth(s.title)));
      const sizeW = Math.max(...sheets.map((s) => `${s.rows}×${s.cols}`.length));
      const idW = Math.max(...sheets.map((s) => String(s.sheetId).length));
      const lines = sheets.map((s) => {
        const titlePad = ' '.repeat(Math.max(0, titleW - visualWidth(s.title)));
        const size = `${s.rows}×${s.cols}`.padStart(sizeW);
        const id = String(s.sheetId).padStart(idW);
        return `${s.title}${titlePad}  ${size}  ${id}  #${s.index}`;
      });
      return lines.join('\n') + '\n';
    }
  }
}

function visualWidth(s: string): number {
  return [...s].length;
}

function resolveSubcommand(deps: SheetDeps): Command {
  const cmd = new Command('resolve');
  describe(cmd, {
    summary: 'Show which spreadsheet ID will be used and where it comes from',
    description: [
      'Diagnostic: prints the resolved spreadsheet ID (if any) and the full list of',
      'sources checked. Resolution order: --spreadsheet/-s → env MPU_SS → config sheet.default.',
      '',
      'Useful for AIs and humans to understand why a particular ID is picked, or why none is.',
    ].join('\n'),
    examples: [
      { cmd: 'sheet resolve', note: 'human-readable, exits 1 if no source set' },
      { cmd: 'sheet resolve --json', note: 'structured output (resolved + all sources)' },
      { cmd: 'sheet resolve -s 1abc... --json', note: 'inspect a specific input' },
    ],
  });
  cmd
    .option('-s, --spreadsheet <id-or-url>', 'spreadsheet ID or full Google Sheets URL')
    .option('--json', 'structured JSON output (does not throw if no source set)')
    .action((opts: { spreadsheet?: string; json?: boolean }) => {
      const inspection = inspectSpreadsheetSources({
        flag: opts.spreadsheet,
        env: () => deps.env('MPU_SS'),
        configDefault: deps.configDefault,
      });
      if (opts.json) {
        deps.print(formatResolveJson(inspection));
        return;
      }
      if (!inspection.resolved) {
        throw new Error(formatResolveHumanMissing(inspection));
      }
      deps.print(formatResolveHuman(inspection));
    });
  return cmd;
}

function formatResolveJson(insp: SpreadsheetInspection): string {
  return JSON.stringify(
    {
      resolved: insp.resolved ?? null,
      checked: insp.checked,
    },
    null,
    2,
  );
}

function formatResolveHuman(insp: SpreadsheetInspection): string {
  const r = insp.resolved!;
  const used = insp.checked.find((c) => c.used)!;
  const lines = [`${r.id}  (source: ${used.label})`, ''];
  for (const c of insp.checked) {
    const marker = c.used ? '*' : ' ';
    const value = c.value ? c.value : '(unset)';
    lines.push(`${marker} ${c.label.padEnd(24)}  ${value}`);
  }
  return lines.join('\n') + '\n';
}

function formatResolveHumanMissing(insp: SpreadsheetInspection): string {
  const lines = [
    'no spreadsheet ID resolved. Sources checked (in order):',
    '',
  ];
  for (const c of insp.checked) {
    lines.push(`  • ${c.label.padEnd(24)}  ${c.value ? c.value : '(unset)'}`);
  }
  lines.push(
    '',
    `Pass --spreadsheet, export MPU_SS, or run \`${MAIN_BIN} config sheet.default <ID>\`.`,
  );
  return lines.join('\n');
}

export interface Cell {
  range: string;
  value?: unknown;
  formula?: string;
}

export function expandCells(
  values: BatchGetResult | undefined,
  formulas: BatchGetResult | undefined,
  render: RenderMode,
): Cell[] {
  const fByRange = new Map<string, unknown[][]>();
  for (const r of formulas?.valueRanges ?? []) fByRange.set(r.range, r.values ?? []);
  const vByRange = new Map<string, unknown[][]>();
  for (const r of values?.valueRanges ?? []) vByRange.set(r.range, r.values ?? []);

  const allKeys = new Set<string>([...vByRange.keys(), ...fByRange.keys()]);
  const cells: Cell[] = [];
  const wantValue = render === 'values' || render === 'both' || render === 'formatted';
  const wantFormula = render === 'formulas' || render === 'both';

  for (const rangeStr of allKeys) {
    let rect;
    try {
      rect = parseA1(rangeStr);
    } catch (e) {
      if (e instanceof A1ParseError) continue;
      throw e;
    }
    if (rect.wholeSheet) continue;

    const vMatrix = vByRange.get(rangeStr);
    const fMatrix = fByRange.get(rangeStr);
    const rows = rect.r2 - rect.r1 + 1;
    const cols = rect.c2 - rect.c1 + 1;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cellRange = `${rect.sheet}!${colNumToA1(rect.c1 + c)}${rect.r1 + r}`;
        const cell: Cell = { range: cellRange };
        if (wantValue) {
          const row = vMatrix?.[r];
          cell.value = row && c < row.length ? row[c] ?? null : null;
        }
        if (wantFormula) {
          const row = fMatrix?.[r];
          const f = row && c < row.length ? row[c] : null;
          if (typeof f === 'string' && f.startsWith('=')) {
            cell.formula = f;
          }
        }
        cells.push(cell);
      }
    }
  }

  return cells;
}

export type CellColumn = 'value' | 'formula';

export function columnsForRender(render: RenderMode): CellColumn[] {
  switch (render) {
    case 'values':
    case 'formatted':
      return ['value'];
    case 'formulas':
      return ['formula'];
    case 'both':
      return ['value', 'formula'];
  }
}

export function formatCells(
  spreadsheetId: string,
  cells: Cell[],
  format: OutputFormat,
  columns: CellColumn[],
): string {
  if (format === 'json') {
    return JSON.stringify({ spreadsheetId, cells }, null, 2);
  }
  const cols: Array<'range' | CellColumn> = ['range', ...columns];
  const lines: string[] = [];
  if (format === 'tsv') {
    lines.push(cols.join('\t'));
  }
  for (const cell of cells) {
    const row = cols.map((k) => {
      const v = (cell as unknown as Record<string, unknown>)[k];
      return v === undefined ? '' : escapeTsv(v);
    });
    lines.push(row.join('\t'));
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

function escapeTsv(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : String(v);
  return s.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t');
}

function stringifyCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return String(v);
}

function defaultDeps(): SheetDeps {
  let cachedClient: WebappClient | null = null;
  let cachedConfig: Config | null = null;
  const env = envLookup();

  const cfg = (): Config => {
    if (!cachedConfig) cachedConfig = getDefaultConfig();
    return cachedConfig;
  };
  const getClient = (): SheetClient => {
    if (!cachedClient) {
      const url = (cfg().get('sheet.url') as string) || env.get('WB_PLUS_WEB_APP_URL');
      if (!url) {
        throw new Error(
          [
            'no Apps Script webapp URL configured.',
            'Set one of:',
            '  • config:  mpu config sheet.url <URL>',
            '  • env in ~/.config/mpu/.env:  WB_PLUS_WEB_APP_URL=<URL>',
          ].join('\n'),
        );
      }
      const retries = cfg().get('http.retries') as number;
      const timeoutMs = (cfg().get('http.timeout') as number) * 1000;
      cachedClient = new WebappClient({
        url,
        timeoutMs,
        policy: {
          maxAttempts: retries,
          baseDelayMs: 250,
          maxDelayMs: 8000,
          jitter: 0.5,
          quotaDelayMs: 60_000,
        },
      });
    }
    const cacheTtl = cfg().get('sheet.cache.ttl') as number;
    if (cacheTtl > 0) {
      return new SheetCache({ db: getDefaultDb(), inner: cachedClient, ttlSec: cacheTtl });
    }
    return cachedClient;
  };
  return {
    getClient,
    getCache: () => getDefaultCache(),
    env: (k) => env.get(k),
    configDefault: () => {
      const v = cfg().get('sheet.default') as string;
      return v || undefined;
    },
    readFile: (p) => fsReadFile(p, 'utf8'),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
    print: (s) => process.stdout.write(s),
  };
}
