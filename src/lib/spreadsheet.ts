import { MAIN_BIN } from './branding.js';

const ID_PATTERN = /^[A-Za-z0-9_-]{20,}$/;
const URL_ID_RE = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/;

export class SpreadsheetResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpreadsheetResolveError';
  }
}

export function parseSpreadsheetUrl(input: string): string {
  if (!input) throw new SpreadsheetResolveError('spreadsheet identifier is empty');
  const m = URL_ID_RE.exec(input);
  if (m) return m[1] as string;
  if (input.startsWith('http')) {
    throw new SpreadsheetResolveError(
      `cannot extract spreadsheet ID from URL "${input}". ` +
        `Expected URL like https://docs.google.com/spreadsheets/d/<ID>/edit`,
    );
  }
  return input;
}

export function looksLikeSpreadsheetId(input: string): boolean {
  return ID_PATTERN.test(input);
}

export interface SmartResolveCandidate {
  ssId: string;
  clientId: number;
  title: string;
  templateName: string | null;
  isActive: boolean;
  server: string | null;
}

export interface ResolveSpreadsheetDeps {
  flag: string | undefined;
  env: () => string | undefined;
  configDefault: () => string | undefined;
  /** Optional alias resolver: name → ssId. */
  lookupAlias?: (name: string) => string | undefined;
  /**
   * Optional smart-resolve over sl_spreadsheets. Receives raw input string;
   * returns one or more matches (numeric → by client_id; non-numeric → fuzzy by title).
   * Empty array = no matches.
   */
  lookupCandidates?: (input: string) => SmartResolveCandidate[];
}

export interface ResolvedSpreadsheet {
  id: string;
  source: 'flag' | 'env' | 'config';
  /** Alias name used (if any). */
  alias?: string;
  /** Smart-resolve match (if any). */
  candidate?: SmartResolveCandidate;
}

export class AmbiguousSpreadsheetError extends Error {
  readonly query: string;
  readonly candidates: SmartResolveCandidate[];
  constructor(query: string, candidates: SmartResolveCandidate[]) {
    const list = candidates
      .slice(0, 10)
      .map(
        (c) =>
          `  client=${c.clientId}${c.isActive ? '' : ' (inactive)'}  ${c.ssId}  ${c.title}`,
      )
      .join('\n');
    const more = candidates.length > 10 ? `\n  …and ${candidates.length - 10} more` : '';
    super(
      [
        `multiple spreadsheets match "${query}" (${candidates.length}):`,
        list + more,
        '',
        'Disambiguate by passing --spreadsheet <full-id-or-url>, or use a more specific query.',
      ].join('\n'),
    );
    this.name = 'AmbiguousSpreadsheetError';
    this.query = query;
    this.candidates = candidates;
  }
}

export type SpreadsheetSource = 'flag' | 'env' | 'config';

export interface SpreadsheetSourceEntry {
  source: SpreadsheetSource;
  label: string;
  value: string | undefined;
  used: boolean;
}

export interface SpreadsheetInspection {
  checked: SpreadsheetSourceEntry[];
  resolved: ResolvedSpreadsheet | undefined;
}

export function inspectSpreadsheetSources(deps: ResolveSpreadsheetDeps): SpreadsheetInspection {
  const flagRaw = deps.flag || undefined;
  const envRaw = deps.env() || undefined;
  const cfgRaw = deps.configDefault() || undefined;

  const order: Array<{ source: SpreadsheetSource; label: string; raw: string | undefined }> = [
    { source: 'flag', label: '--spreadsheet/-s', raw: flagRaw },
    { source: 'env', label: 'env MPU_SS', raw: envRaw },
    { source: 'config', label: 'config sheet.default', raw: cfgRaw },
  ];

  let resolved: ResolvedSpreadsheet | undefined;
  for (const o of order) {
    if (resolved || !o.raw) continue;
    if (o.raw.startsWith('http') || looksLikeSpreadsheetId(o.raw)) {
      resolved = { id: parseSpreadsheetUrl(o.raw), source: o.source };
      continue;
    }
    const aliasId = deps.lookupAlias?.(o.raw);
    if (aliasId) {
      resolved = { id: aliasId, source: o.source, alias: o.raw };
      continue;
    }
    if (deps.lookupCandidates) {
      const cands = deps.lookupCandidates(o.raw);
      if (cands.length === 1) {
        const c = cands[0]!;
        resolved = { id: c.ssId, source: o.source, candidate: c };
        continue;
      }
      if (cands.length > 1) {
        throw new AmbiguousSpreadsheetError(o.raw, cands);
      }
    }
    resolved = { id: parseSpreadsheetUrl(o.raw), source: o.source };
  }

  const checked: SpreadsheetSourceEntry[] = order.map((o) => ({
    source: o.source,
    label: o.label,
    value: o.raw,
    used: resolved?.source === o.source,
  }));

  return { checked, resolved };
}

export function resolveSpreadsheetId(deps: ResolveSpreadsheetDeps): ResolvedSpreadsheet {
  const { resolved } = inspectSpreadsheetSources(deps);
  if (resolved) return resolved;
  throw new SpreadsheetResolveError(
    [
      'no spreadsheet ID provided. Tried (in order):',
      '  1. --spreadsheet/-s <ID-or-URL>',
      '  2. environment variable MPU_SS',
      `  3. config key sheet.default (set via \`${MAIN_BIN} config sheet.default <ID>\`)`,
      '',
      `Pass --spreadsheet, export MPU_SS, or run \`${MAIN_BIN} config sheet.default <ID>\`.`,
    ].join('\n'),
  );
}

export interface ResolveRangesDeps {
  positional: string[];
  sheet: string | undefined;
  from: string | undefined;
  readFile: (path: string) => Promise<string>;
  readStdin: () => Promise<string>;
}

export async function resolveRanges(deps: ResolveRangesDeps): Promise<string[]> {
  const all: string[] = [];
  for (const p of deps.positional) all.push(p);
  if (deps.from !== undefined) {
    const text = deps.from === '-' ? await deps.readStdin() : await deps.readFile(deps.from);
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t === '' || t.startsWith('#')) continue;
      all.push(t);
    }
  }
  if (all.length === 0) {
    throw new SpreadsheetResolveError(
      [
        'no ranges provided. Provide one or more of:',
        '  • positional args:    sheet get "Sheet1!A1:B2" "Sheet2!C3"',
        '  • short form + --sheet: sheet get -n Sheet1 A1:B2 C3',
        '  • file:               sheet get --from ranges.txt',
        '  • stdin:              echo "Sheet1!A1" | sheet get --from -',
      ].join('\n'),
    );
  }
  const qualified = qualifyRanges(all, deps.sheet);
  return dedupePreserveOrder(qualified);
}

export function qualifyRanges(ranges: string[], sheet: string | undefined): string[] {
  return ranges.map((r) => {
    if (r.includes('!')) return r;
    if (!sheet) {
      throw new SpreadsheetResolveError(
        `range "${r}" has no sheet prefix and --sheet/-n was not provided. ` +
          `Use "Sheet!${r}" or pass --sheet <name>.`,
      );
    }
    return `${sheet}!${r}`;
  });
}

function dedupePreserveOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}
