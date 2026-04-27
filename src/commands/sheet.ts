import { Command } from 'commander';
import { readFile as fsReadFile } from 'node:fs/promises';
import { describe } from '../lib/help.js';
import { setProvider } from '../lib/completion.js';
import { resolveRanges, resolveSpreadsheetId } from '../lib/spreadsheet.js';
import { WebappClient } from '../lib/webapp.js';
import { envLookup } from '../lib/env.js';
import { getDefaultConfig } from '../lib/config.js';
import type { Config } from '../lib/config.js';
import { getDefaultDb } from '../lib/db.js';
import { SheetCache } from '../lib/sheet-cache.js';

export interface BatchGetResult {
  valueRanges: Array<{ range: string; values?: unknown[][]; majorDimension?: string }>;
}

export interface SheetClient {
  do: <T = unknown>(action: string, payload: Record<string, unknown>) => Promise<T>;
}

export interface SheetDeps {
  getClient: () => SheetClient;
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
      { cmd: "sheet get 'S!A1' --render formulas", note: 'fetch formulas instead of values' },
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
      'value render mode: values (default, UNFORMATTED_VALUE) | formulas (FORMULA) | formatted (FORMATTED_VALUE)',
      'values',
    )
    .option('--json', 'output structured JSON (default)')
    .option('--raw', 'bare values; single cell prints without trailing newline')
    .option('--tsv', 'TSV output (tab-separated, range-separated by blank line)')
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
        },
      ) => {
        const renderMode = RENDER_MAP[opts.render];
        if (!renderMode) {
          throw new Error(
            `unknown --render value "${opts.render}". Valid: values | formulas | formatted`,
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
        const result = await client.do<BatchGetResult>('spreadsheets/values/batchGet', {
          ssId,
          ranges,
          majorDimension: 'ROWS',
          valueRenderOption: renderMode,
          dateTimeRenderOption: 'SERIAL_NUMBER',
        });

        deps.print(formatOutput(ssId, result, { format }));
      },
    );

  cmd.addCommand(get);
  return cmd;
}

export function formatOutput(
  spreadsheetId: string,
  result: BatchGetResult,
  opts: { format: OutputFormat },
): string {
  switch (opts.format) {
    case 'json':
      return JSON.stringify(
        { spreadsheetId, valueRanges: result.valueRanges ?? [] },
        null,
        2,
      );
    case 'raw': {
      const ranges = result.valueRanges ?? [];
      if (ranges.length === 1) {
        const values = ranges[0]!.values ?? [];
        if (values.length === 1 && values[0]!.length === 1) {
          return stringifyCell(values[0]![0]);
        }
        return rangeToTsv(values);
      }
      return ranges.map((r) => rangeToTsv(r.values ?? [])).join('\n');
    }
    case 'tsv': {
      const ranges = result.valueRanges ?? [];
      return ranges.map((r) => rangeToTsv(r.values ?? [])).join('\n');
    }
  }
}

function rangeToTsv(values: unknown[][]): string {
  return values.map((row) => row.map(stringifyCell).join('\t')).join('\n') + '\n';
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
