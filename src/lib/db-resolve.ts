import type { SlSpreadsheetRow } from './sl-spreadsheets.js';
import type { SlClientRow } from './sl-clients.js';
import { resolveServerIp, looksLikeIp, type EnvGetter } from './server-resolve.js';
import { looksLikeSpreadsheetId } from './spreadsheet.js';

export interface SsLookup {
  get: (ssId: string) => SlSpreadsheetRow | undefined;
  /** Подстрока в ss_id — не только prefix. */
  bySubstring: (fragment: string) => SlSpreadsheetRow[];
  fuzzyByTitle: (query: string) => SlSpreadsheetRow[];
}

export interface ClientLookup {
  get: (clientId: number) => SlClientRow | undefined;
  byServer: (server: string) => SlClientRow[];
}

export interface DbResolveDeps {
  ss: SsLookup;
  clients: ClientLookup;
  env: EnvGetter;
}

export interface DbResolveInput {
  hint?: string;
  ss?: string;
  client?: number;
  server?: string;
  schema?: string;
}

export type DbTarget =
  | { kind: 'client'; clientId: number; server: string; ip: string }
  | { kind: 'direct'; server: string; ip: string; schema: string };

export class DbResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbResolveError';
  }
}

interface Candidate {
  target: DbTarget;
  via: string;
}

export function resolveDbTarget(input: DbResolveInput, deps: DbResolveDeps): DbTarget {
  const candidates = collect(input, deps);

  if (candidates.length === 0) {
    if (!input.hint && !input.ss && input.client === undefined && !input.server) {
      throw new DbResolveError(
        'specify a positional <hint> or one of --ss/--client/--server (with --schema). ' +
          'Examples:\n' +
          '  new-mpu db query 1YCG33sFW...                # by spreadsheet ID\n' +
          '  new-mpu db query 3377                          # by client_id\n' +
          '  new-mpu db query "PrintPortal"                 # by title fuzzy\n' +
          '  new-mpu db query --server sl-1 --schema 42',
      );
    }
    throw new DbResolveError(formatNoMatch(input));
  }

  const unique = dedupe(candidates);
  if (unique.length === 1) return unique[0]!.target;
  throw new DbResolveError(formatAmbiguous(input, unique));
}

function collect(input: DbResolveInput, deps: DbResolveDeps): Candidate[] {
  const out: Candidate[] = [];

  if (input.ss) {
    const row = deps.ss.get(input.ss);
    if (!row) throw new DbResolveError(`--ss "${input.ss}" not found in sl_spreadsheets. Run \`new-mpu sheet sync\` first.`);
    out.push({ target: requireClientCandidate(row.clientId, deps), via: `--ss ${input.ss}` });
  }
  if (input.client !== undefined) {
    out.push({ target: requireClientCandidate(input.client, deps), via: `--client ${input.client}` });
  }
  if (input.server && input.schema) {
    const ip = resolveServerIp(input.server, deps.env);
    out.push({
      target: { kind: 'direct', server: input.server, ip, schema: normalizeSchema(input.schema) },
      via: `--server ${input.server} --schema ${input.schema}`,
    });
  } else if (input.server && !input.schema && !input.hint) {
    throw new DbResolveError('--server requires --schema (or pass a hint that resolves a client)');
  }

  if (input.hint) collectFromHint(input.hint, input.schema, deps, out);

  return out;
}

function collectFromHint(
  raw: string,
  schemaFlag: string | undefined,
  deps: DbResolveDeps,
  out: Candidate[],
): void {
  const hint = raw.trim();
  if (!hint) return;

  if (looksLikeSpreadsheetId(hint)) {
    const row = deps.ss.get(hint);
    if (row) {
      out.push({ target: requireClientCandidate(row.clientId, deps), via: `ssId=${hint}` });
      return;
    }
  }

  if (/^\d+$/.test(hint)) {
    const id = Number.parseInt(hint, 10);
    const t = clientCandidateOrNull(id, deps);
    if (t) {
      out.push({ target: t, via: `client_id=${id}` });
      return;
    }
    // numeric but no such client — fall through to prefix/title heuristics
  }

  if (looksLikeIp(hint)) {
    if (!schemaFlag) {
      throw new DbResolveError(
        `IP "${hint}" requires --schema (we don't know which schema to query). ` +
          'Pass --schema <client_id-or-name>, or use --server + --schema.',
      );
    }
    out.push({
      target: { kind: 'direct', server: hint, ip: hint, schema: normalizeSchema(schemaFlag) },
      via: `ip=${hint}`,
    });
    return;
  }

  // server name? try resolving via env
  let serverIp: string | undefined;
  try {
    serverIp = resolveServerIp(hint, deps.env);
  } catch {
    // not a known server name
  }
  if (serverIp !== undefined) {
    if (schemaFlag) {
      out.push({
        target: { kind: 'direct', server: hint, ip: serverIp, schema: normalizeSchema(schemaFlag) },
        via: `server=${hint}`,
      });
      return;
    }
    const onServer = deps.clients.byServer(hint);
    if (onServer.length === 1) {
      out.push({
        target: requireClientCandidate(onServer[0]!.clientId, deps),
        via: `server=${hint} (single client)`,
      });
      return;
    }
    if (onServer.length > 1) {
      throw new DbResolveError(
        `ambiguous: server "${hint}" has ${onServer.length} clients (${onServer.map((c) => c.clientId).join(', ')}); ` +
          'pass --schema <client_id> to disambiguate, or use --client <id>.',
      );
    }
    // 0 clients on this server → fall through to other heuristics (might still be ssId prefix)
  }

  // ssId substring (включая prefix и middle-fragment)
  const bySubstring = deps.ss.bySubstring(hint);
  if (bySubstring.length === 1) {
    out.push({
      target: requireClientCandidate(bySubstring[0]!.clientId, deps),
      via: `ssId-fragment=${hint}`,
    });
    return;
  }
  if (bySubstring.length > 1) {
    throw new DbResolveError(
      `ambiguous ssId fragment "${hint}" — multiple spreadsheets match (${bySubstring.length}):\n` +
        bySubstring
          .slice(0, 10)
          .map((r) => `  ${r.ssId}  client=${r.clientId}  ${r.title}`)
          .join('\n') +
        (bySubstring.length > 10 ? `\n  …and ${bySubstring.length - 10} more` : '') +
        '\nPass a longer fragment or full ID.',
    );
  }

  // title fuzzy
  const fuzzy = deps.ss.fuzzyByTitle(hint);
  if (fuzzy.length === 0) {
    throw new DbResolveError(formatNoMatch({ hint }));
  }
  // exact-title fast-path: case-insensitive equality wins regardless of fuzzy noise
  const hintLc = hint.toLowerCase();
  const exact = fuzzy.filter((r) => r.title.toLowerCase() === hintLc);
  if (exact.length === 1) {
    out.push({
      target: requireClientCandidate(exact[0]!.clientId, deps),
      via: `title-exact="${exact[0]!.title}"`,
    });
    return;
  }
  if (fuzzy.length === 1) {
    out.push({
      target: requireClientCandidate(fuzzy[0]!.clientId, deps),
      via: `title="${fuzzy[0]!.title}"`,
    });
    return;
  }
  // multiple fuzzy (or multiple exact) hits — ambiguous
  const display = exact.length > 1 ? exact : fuzzy;
  throw new DbResolveError(
    `ambiguous title "${hint}" — multiple spreadsheets match (${display.length}):\n` +
      display
        .slice(0, 10)
        .map((r) => `  ${r.ssId}  client=${r.clientId}  ${r.title}`)
        .join('\n') +
      (display.length > 10 ? `\n  …and ${display.length - 10} more` : '') +
      '\nPass a more specific query, or --ss/--client.',
  );
}

function requireClientCandidate(clientId: number, deps: DbResolveDeps): DbTarget {
  const row = deps.clients.get(clientId);
  if (!row) {
    throw new DbResolveError(
      `client ${clientId} not found in local sl_clients. Run \`new-mpu db sync\` first.`,
    );
  }
  if (!row.server) {
    throw new DbResolveError(`client ${clientId} has no server in sl_clients (server=NULL).`);
  }
  const ip = resolveServerIp(row.server, deps.env);
  return { kind: 'client', clientId, server: row.server, ip };
}

function clientCandidateOrNull(clientId: number, deps: DbResolveDeps): DbTarget | null {
  const row = deps.clients.get(clientId);
  if (!row || !row.server) return null;
  try {
    const ip = resolveServerIp(row.server, deps.env);
    return { kind: 'client', clientId, server: row.server, ip };
  } catch {
    return null;
  }
}

function dedupe(cands: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of cands) {
    const key = targetKey(c.target);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function targetKey(t: DbTarget): string {
  if (t.kind === 'client') return `client:${t.clientId}@${t.server}`;
  return `direct:${t.server}/${t.schema}`;
}

function normalizeSchema(s: string): string {
  if (s.startsWith('schema_')) return s;
  if (/^\d+$/.test(s)) return `schema_${s}`;
  return s;
}

function formatNoMatch(input: { hint?: string }): string {
  return (
    `no match for "${input.hint ?? ''}". Tried: full ssId, ssId prefix, client_id, IP, server name, title fuzzy.\n` +
    'If you expect this to resolve, run `new-mpu sheet sync && new-mpu db sync` first.'
  );
}

function formatAmbiguous(input: DbResolveInput, cands: Candidate[]): string {
  const lines = cands.slice(0, 10).map((c) => `  ${describeTarget(c.target)}  (via ${c.via})`);
  const more = cands.length > 10 ? `\n  …and ${cands.length - 10} more` : '';
  return (
    `multiple distinct targets matched (${cands.length}):\n` +
    lines.join('\n') +
    more +
    '\nDisambiguate with --ss / --client / (--server + --schema).'
  );
}

function describeTarget(t: DbTarget): string {
  if (t.kind === 'client') return `client=${t.clientId}  server=${t.server}  ip=${t.ip}`;
  return `direct  server=${t.server}  ip=${t.ip}  schema=${t.schema}`;
}
