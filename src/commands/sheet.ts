import { Command } from 'commander';
import { readFile as fsReadFile } from 'node:fs/promises';
import { describe } from '../lib/help.js';
import { setProvider } from '../lib/completion.js';
import {
  AmbiguousSpreadsheetError,
  inspectSpreadsheetSources,
  parseSpreadsheetUrl,
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
import { SheetAliases, getDefaultSheetAliases } from '../lib/sheet-aliases.js';
import { SlSpreadsheets, getDefaultSlSpreadsheets, type SlSpreadsheetRow } from '../lib/sl-spreadsheets.js';
import { SlApi } from '../lib/slapi.js';

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
  getAliases: () => SheetAliases;
  getSlStore: () => SlSpreadsheets;
  /** Lazy SlApi factory (throws if BASE_API_URL/credentials missing). */
  buildSlApi: () => SlApi;
  env: (key: string) => string | undefined;
  configDefault: () => string | undefined;
  isProtected: () => boolean;
  readFile: (path: string) => Promise<string>;
  readStdin: () => Promise<string>;
  print: (text: string) => void;
  openUrl: (url: string) => Promise<void>;
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
          lookupAlias: (n) => deps.getAliases().get(n),
          lookupCandidates: (q) => smartLookup(deps.getSlStore(), q),
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
  cmd.addCommand(openSubcommand(deps));
  cmd.addCommand(aliasSubcommand(deps));
  cmd.addCommand(setSubcommand(deps));
  cmd.addCommand(syncSubcommand(deps));
  return cmd;
}

export function smartLookup(store: SlSpreadsheets, raw: string): SlSpreadsheetRow[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (store.count() === 0) {
    throw new Error(
      [
        `cannot smart-resolve "${trimmed}": local sl_spreadsheets is empty.`,
        'Run `sheet sync` first to enable lookup by client_id or title,',
        'or pass --spreadsheet <full-ID-or-URL>.',
      ].join('\n'),
    );
  }
  if (/^\d+$/.test(trimmed)) {
    return store.byClientId(Number.parseInt(trimmed, 10));
  }
  return store.fuzzyByTitle(trimmed, 20);
}

function syncSubcommand(deps: SheetDeps): Command {
  const cmd = new Command('sync');
  describe(cmd, {
    summary: 'Pull spreadsheet metadata from sl-back into local cache',
    description: [
      'Fetch the full list of spreadsheets via sl-back GET /admin/ss and store',
      'in the local SQLite database (sl_spreadsheets). Enables smart resolve:',
      '  • numeric -s 42  → match by client_id',
      '  • text -s "cool flaps" → fuzzy match by title',
      '',
      'Requires env: BASE_API_URL (or NEXT_PUBLIC_SERVER_URL), TOKEN_EMAIL, TOKEN_PASSWORD.',
    ].join('\n'),
    examples: [
      { cmd: 'sheet sync', note: 'fetch and store (token cached 10 min)' },
      { cmd: 'sheet sync --json', note: 'print synced rows' },
    ],
  });
  cmd
    .option('--json', 'print synced rows as JSON')
    .action(async (opts: { json?: boolean }) => {
      const api = deps.buildSlApi();
      const rows = await api.getSpreadsheets();
      deps.getSlStore().replaceAll(rows);
      if (opts.json) {
        deps.print(JSON.stringify(rows, null, 2));
      } else {
        deps.print(`synced ${rows.length} spreadsheets\n`);
      }
    });
  return cmd;
}

export interface UpdateEntry {
  range: string;
  value: string;
}

export function parseUpdates(text: string): UpdateEntry[] {
  const out: UpdateEntry[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) {
      throw new Error(
        `parseUpdates: line ${i + 1} has no tab separator. Expected "range<TAB>value", got "${line}"`,
      );
    }
    out.push({
      range: line.slice(0, tab).trim(),
      value: unescapeTsv(line.slice(tab + 1)),
    });
  }
  return out;
}

function unescapeTsv(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '\\' || i + 1 >= s.length) {
      out += ch;
      continue;
    }
    const next = s[i + 1];
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === '\\') out += '\\';
    else out += ch + next;
    i++;
  }
  return out;
}

interface BatchUpdateResponse {
  spreadsheetId?: string;
  responses?: Array<{ updatedRange?: string; updatedCells?: number }>;
}

function setSubcommand(deps: SheetDeps): Command {
  const cmd = new Command('set');
  describe(cmd, {
    summary: 'Write values to one or more cells/ranges',
    description: [
      'Write values via spreadsheets/values/batchUpdate.',
      '',
      'Default valueInputOption is USER_ENTERED — strings like "=A1*2" become formulas, "123" becomes a number.',
      'Use --literal/-l to write values as RAW (no parsing).',
      '',
      'Protected mode: by default writes require explicit --force/-f. Disable globally with',
      `\`${MAIN_BIN} config sheet.protected false\`.`,
      '',
      'After a successful update the covering cache invalidates the touched cells automatically.',
    ].join('\n'),
    examples: [
      { cmd: "sheet set 'Sheet1!A1' hello -f", note: 'single cell' },
      { cmd: "sheet set 'Sheet1!A1' '=A2*2' -f", note: 'formula' },
      { cmd: 'sheet set --from updates.tsv -f', note: 'batch (range<TAB>value per line)' },
      { cmd: "echo 'S!A1\\thi' | sheet set --from - -f", note: 'stdin' },
      { cmd: 'sheet set "S!A1" abc -f --literal', note: 'RAW mode — write "=foo" literally' },
    ],
  });
  cmd
    .argument('[range]', 'A1 range (single update form)')
    .argument('[value]', 'value to write (single update form)')
    .option('-s, --spreadsheet <id-or-url>', 'spreadsheet ID, URL, or alias')
    .option('--from <file>', 'batch from file (one "range<TAB>value" per line, # comments). Use - for stdin')
    .option('-f, --force', 'allow write when sheet.protected=true (which is the default)')
    .option('-l, --literal', 'use RAW value input (do not parse formulas/numbers)')
    .action(
      async (
        range: string | undefined,
        value: string | undefined,
        opts: { spreadsheet?: string; from?: string; force?: boolean; literal?: boolean },
      ) => {
        if (deps.isProtected() && !opts.force) {
          throw new Error(
            [
              'sheet.protected is true; write blocked.',
              'Pass --force/-f for one-off writes, or disable globally:',
              `  ${MAIN_BIN} config sheet.protected false`,
            ].join('\n'),
          );
        }

        let updates: UpdateEntry[];
        if (opts.from !== undefined) {
          const text = opts.from === '-' ? await deps.readStdin() : await deps.readFile(opts.from);
          updates = parseUpdates(text);
        } else {
          if (!range || value === undefined) {
            throw new Error(
              'sheet set requires <range> <value> or --from <file>. ' +
                'Examples:\n  sheet set Sheet1!A1 hello -f\n  sheet set --from updates.tsv -f',
            );
          }
          updates = [{ range, value }];
        }
        if (updates.length === 0) {
          throw new Error('no updates to apply (empty input)');
        }

        const { id: ssId } = resolveSpreadsheetId({
          flag: opts.spreadsheet,
          env: () => deps.env('MPU_SS'),
          configDefault: deps.configDefault,
          lookupAlias: (n) => deps.getAliases().get(n),
          lookupCandidates: (q) => smartLookup(deps.getSlStore(), q),
        });

        const client = deps.getClient();
        const data = updates.map((u) => ({ range: u.range, values: [[u.value]] }));
        const result = await client.do<BatchUpdateResponse>('spreadsheets/values/batchUpdate', {
          ssId,
          requestBody: {
            valueInputOption: opts.literal ? 'RAW' : 'USER_ENTERED',
            data,
          },
        });

        const responses = result.responses ?? [];
        const updatesOut = responses.map((r, i) => ({
          range: r.updatedRange ?? updates[i]?.range ?? '',
          updatedCells: r.updatedCells ?? 0,
        }));
        deps.print(
          JSON.stringify(
            { spreadsheetId: result.spreadsheetId ?? ssId, updates: updatesOut },
            null,
            2,
          ),
        );
      },
    );
  return cmd;
}

function aliasSubcommand(deps: SheetDeps): Command {
  const cmd = new Command('alias');
  describe(cmd, {
    summary: 'Manage spreadsheet aliases (short names → IDs)',
    description: [
      'Map a short name to a spreadsheet ID/URL. Aliases work anywhere a spreadsheet is accepted:',
      '--spreadsheet/-s, env MPU_SS, config sheet.default.',
      '',
      'Names must match [A-Za-z0-9_.-]+ (no spaces, shell-friendly).',
    ].join('\n'),
    examples: [
      { cmd: 'sheet alias add prod 1abc...', note: 'create or replace' },
      { cmd: 'sheet alias add dev https://docs.google.com/spreadsheets/d/1xyz/edit' },
      { cmd: 'sheet alias ls', note: 'list all aliases' },
      { cmd: 'sheet alias rm prod' },
      { cmd: 'sheet get -s prod "UNIT!A1"', note: 'use alias instead of ID' },
    ],
  });

  const add = new Command('add');
  describe(add, { summary: 'Add or replace an alias' });
  add
    .argument('<name>', 'alias name ([A-Za-z0-9_.-]+)')
    .argument('<id-or-url>', 'spreadsheet ID or full Google Sheets URL')
    .action((name: string, idOrUrl: string) => {
      const ssId = parseSpreadsheetUrl(idOrUrl);
      deps.getAliases().add(name, ssId);
      deps.print(`alias ${name} → ${ssId}\n`);
    });
  cmd.addCommand(add);

  const ls = new Command('ls');
  describe(ls, { summary: 'List all aliases' });
  ls.option('--json', 'structured JSON output').action((opts: { json?: boolean }) => {
    const entries = deps.getAliases().list();
    if (opts.json) {
      deps.print(JSON.stringify(entries, null, 2));
      return;
    }
    if (entries.length === 0) {
      deps.print('no aliases configured; add one with: mpu sheet alias add <name> <id-or-url>\n');
      return;
    }
    const w = Math.max(...entries.map((e) => e.name.length));
    const lines = entries.map((e) => `${e.name.padEnd(w)}  ${e.ssId}`);
    deps.print(lines.join('\n') + '\n');
  });
  cmd.addCommand(ls);

  const rm = new Command('rm');
  describe(rm, { summary: 'Remove an alias' });
  rm.argument('<name>', 'alias name').action((name: string) => {
    deps.getAliases().remove(name);
    deps.print(`removed ${name}\n`);
  });
  cmd.addCommand(rm);

  return cmd;
}

export function buildSpreadsheetUrl(ssId: string, gid?: number): string {
  const base = `https://docs.google.com/spreadsheets/d/${ssId}/edit`;
  return gid === undefined ? base : `${base}#gid=${gid}`;
}

function openSubcommand(deps: SheetDeps): Command {
  const cmd = new Command('open');
  describe(cmd, {
    summary: 'Open a spreadsheet (or specific sheet) in the browser',
    description: [
      'Open the Google Sheets editor URL for the resolved spreadsheet.',
      'When a sheet name is given, jumps to that tab via #gid=N (resolved from cached metadata).',
    ].join('\n'),
    examples: [
      { cmd: 'sheet open', note: 'open default spreadsheet' },
      { cmd: 'sheet open UNIT', note: 'open and jump to sheet "UNIT"' },
      { cmd: 'sheet open --print', note: 'just print URL (for piping into xdg-open, clipboard, etc.)' },
      { cmd: 'sheet open -s 1abc... TabName' },
    ],
  });
  cmd
    .argument('[sheet]', 'sheet (tab) name to jump to')
    .option('-s, --spreadsheet <id-or-url>', 'spreadsheet ID or full Google Sheets URL')
    .option('--print', 'print URL to stdout instead of launching browser')
    .action(async (sheetName: string | undefined, opts: { spreadsheet?: string; print?: boolean }) => {
      const { id: ssId } = resolveSpreadsheetId({
        flag: opts.spreadsheet,
        env: () => deps.env('MPU_SS'),
        configDefault: deps.configDefault,
          lookupAlias: (n) => deps.getAliases().get(n),
          lookupCandidates: (q) => smartLookup(deps.getSlStore(), q),
      });

      let gid: number | undefined;
      if (sheetName) {
        const client = deps.getClient();
        const cache = deps.getCache();
        const result = await cache.wrapAsync(
          `sheet:info:${ssId}`,
          () => client.do<SpreadsheetsGetResponse>('spreadsheets/get', { ssId }),
        );
        const matched = (result.sheets ?? []).find(
          (s) => s.properties?.title === sheetName,
        );
        if (!matched) {
          const titles = (result.sheets ?? [])
            .map((s) => s.properties?.title ?? '')
            .filter(Boolean);
          throw new Error(
            `sheet "${sheetName}" not found. Available: ${titles.join(', ')}`,
          );
        }
        gid = matched.properties?.sheetId;
      }

      const url = buildSpreadsheetUrl(ssId, gid);
      if (opts.print) {
        deps.print(`${url}\n`);
        return;
      }
      await deps.openUrl(url);
    });
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
          lookupAlias: (n) => deps.getAliases().get(n),
          lookupCandidates: (q) => smartLookup(deps.getSlStore(), q),
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
      let inspection: SpreadsheetInspection;
      let ambiguous: AmbiguousSpreadsheetError | undefined;
      try {
        inspection = inspectSpreadsheetSources({
          flag: opts.spreadsheet,
          env: () => deps.env('MPU_SS'),
          configDefault: deps.configDefault,
          lookupAlias: (n) => deps.getAliases().get(n),
          lookupCandidates: (q) => smartLookup(deps.getSlStore(), q),
        });
      } catch (e) {
        if (e instanceof AmbiguousSpreadsheetError && opts.json) {
          ambiguous = e;
          inspection = { checked: [], resolved: undefined };
        } else {
          throw e;
        }
      }
      if (opts.json) {
        if (ambiguous) {
          deps.print(
            JSON.stringify(
              {
                resolved: null,
                ambiguous: { query: ambiguous.query, candidates: ambiguous.candidates },
              },
              null,
              2,
            ),
          );
          return;
        }
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
    getAliases: () => getDefaultSheetAliases(),
    getSlStore: () => getDefaultSlSpreadsheets(),
    buildSlApi: () => buildDefaultSlApi(env.get.bind(env)),
    env: (k) => env.get(k),
    isProtected: () => cfg().get('sheet.protected') as boolean,
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
    openUrl: launchBrowser,
  };
}

function buildDefaultSlApi(getEnv: (k: string) => string | undefined): SlApi {
  const host = getEnv('NEXT_PUBLIC_SERVER_URL');
  const apiBase = getEnv('BASE_API_URL');
  // BASE_API_URL может быть full URL или path-prefix ("/api"). Комбинируем с host если path.
  let baseUrl: string | undefined;
  if (apiBase?.startsWith('http')) baseUrl = apiBase;
  else if (apiBase && host) baseUrl = host.replace(/\/+$/, '') + '/' + apiBase.replace(/^\/+/, '');
  else if (host) baseUrl = host;
  const email = getEnv('TOKEN_EMAIL');
  const password = getEnv('TOKEN_PASSWORD');
  const missing = [
    !baseUrl && 'NEXT_PUBLIC_SERVER_URL or BASE_API_URL (full URL)',
    !email && 'TOKEN_EMAIL',
    !password && 'TOKEN_PASSWORD',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      [
        `sl-back credentials missing in env: ${missing.join(', ')}`,
        'Set them in process env or in ~/.config/mpu/.env',
      ].join('\n'),
    );
  }
  const cache = getDefaultCache();
  const tokenKey = 'sl:token';
  return new SlApi({
    baseUrl: baseUrl as string,
    email: email as string,
    password: password as string,
    getCachedToken: () => cache.get<string>(tokenKey),
    setCachedToken: (t) => cache.set(tokenKey, t, { ttl: 600 }),
  });
}

async function launchBrowser(url: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  const launcher =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launcher, [url], { stdio: 'ignore', detached: true });
    child.on('error', reject);
    child.on('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
