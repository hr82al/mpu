import { Command } from 'commander';
import { describe } from '../lib/help.js';
import { setProvider } from '../lib/completion.js';
import { envLookup } from '../lib/env.js';
import { resolveServerIp, type EnvGetter } from '../lib/server-resolve.js';
import {
  resolveDbTarget,
  type DbTarget,
  type DbResolveDeps,
  type SsLookup,
  type ClientLookup,
} from '../lib/db-resolve.js';
import { getDefaultSlSpreadsheets, SlSpreadsheets } from '../lib/sl-spreadsheets.js';
import { getDefaultSlClients, SlClients } from '../lib/sl-clients.js';
import { getDefaultCache, Cache } from '../lib/cache.js';
import { SlApi } from '../lib/slapi.js';
import { pgQuery, type PgQueryResult, type PgClientFactory } from '../lib/pgclient.js';

export interface DbDeps {
  getSlSs: () => SlSpreadsheets;
  getSlClients: () => SlClients;
  getCache: () => Cache;
  buildSlApi: () => SlApi;
  env: EnvGetter;
  pgClientFactory?: PgClientFactory;
  print: (text: string) => void;
  readStdin: () => Promise<string>;
  stdinIsTty: () => boolean;
}

export type DbOutputFormat = 'json' | 'tsv' | 'csv';

export function dbCommand(deps: DbDeps = defaultDeps()): Command {
  const cmd = new Command('db');
  describe(cmd, {
    summary: 'PostgreSQL access by spreadsheet/client/server',
    description:
      'Resolve a target PG database (server + schema) from spreadsheet ID, client ID, ' +
      'server name or IP, and run SQL against it. Source-of-truth for client→server map ' +
      'is the local sl_clients table (populated by `db sync`).',
  });
  cmd.addCommand(syncSubcommand(deps));
  cmd.addCommand(serverSubcommand(deps));
  cmd.addCommand(ipSubcommand(deps));
  cmd.addCommand(querySubcommand(deps));
  return cmd;
}

function buildResolveDeps(deps: DbDeps): DbResolveDeps {
  const ssStore = deps.getSlSs();
  const clientsStore = deps.getSlClients();
  const ss: SsLookup = {
    get: (id) => ssStore.list().find((r) => r.ssId === id),
    bySubstring: (frag) => (frag ? ssStore.list().filter((r) => r.ssId.includes(frag)) : []),
    fuzzyByTitle: (q) => ssStore.fuzzyByTitle(q, 20),
  };
  const clients: ClientLookup = {
    get: (id) => clientsStore.get(id),
    byServer: (s) => clientsStore.byServer(s),
  };
  return { ss, clients, env: deps.env };
}

function syncSubcommand(deps: DbDeps): Command {
  const cmd = new Command('sync');
  describe(cmd, {
    summary: 'Pull client list (with server field) from sl-back into local sl_clients',
    description: [
      'Fetch the full client list via sl-back GET /admin/client and store in local SQLite.',
      'Required for `db query`, `db server`, and any client_id → server lookup.',
      '',
      'Required env: BASE_API_URL (or NEXT_PUBLIC_SERVER_URL), TOKEN_EMAIL, TOKEN_PASSWORD.',
    ].join('\n'),
    examples: [
      { cmd: 'new-mpu db sync', note: 'fetch and store; reuses cached token (10 min)' },
      { cmd: 'new-mpu db sync --json', note: 'print synced rows' },
    ],
  });
  cmd.option('--json', 'print synced rows as JSON').action(async (opts: { json?: boolean }) => {
    const api = deps.buildSlApi();
    const rows = await api.getClients();
    deps.getSlClients().replaceAll(rows);
    if (opts.json) deps.print(JSON.stringify(rows, null, 2) + '\n');
    else deps.print(`synced ${rows.length} clients\n`);
  });
  return cmd;
}

function serverSubcommand(deps: DbDeps): Command {
  const cmd = new Command('server');
  describe(cmd, {
    summary: 'Resolve hint → client_id, server name, IP',
    description: [
      'Print the resolved server (and IP) for a given hint. Hint can be:',
      '  • full or partial spreadsheet ID',
      '  • client_id (numeric)',
      '  • title fuzzy ("PrintPortal | 10X WB" → unique match)',
      '  • IP / server name (sl-1)',
      '',
      'Combines flag-style overrides too: --ss, --client, --server, --schema.',
    ].join('\n'),
    examples: [
      { cmd: 'new-mpu db server 1YCG33sFW...', note: 'by spreadsheet ID' },
      { cmd: 'new-mpu db server 3377', note: 'by client_id' },
      { cmd: 'new-mpu db server "PrintPortal"', note: 'by title fuzzy' },
      { cmd: 'new-mpu db server --ss 1YCG33sFW... --json' },
    ],
  });
  setProvider(cmd, () => []);
  cmd
    .argument('[hint]', 'spreadsheet ID / client_id / server / title')
    .option('-s, --ss <id>', 'spreadsheet ID')
    .option('-c, --client <id>', 'client_id', (v) => Number.parseInt(v, 10))
    .option('--server <name>', 'server name (sl-1) or IP')
    .option('--schema <name>', 'schema name (e.g. 42 → schema_42)')
    .option('--json', 'structured JSON output')
    .action(
      (
        hint: string | undefined,
        opts: { ss?: string; client?: number; server?: string; schema?: string; json?: boolean },
      ) => {
        const target = resolveDbTarget(
          { hint, ss: opts.ss, client: opts.client, server: opts.server, schema: opts.schema },
          buildResolveDeps(deps),
        );
        if (opts.json) {
          deps.print(JSON.stringify(target, null, 2) + '\n');
          return;
        }
        deps.print(formatTargetHuman(target));
      },
    );
  return cmd;
}

function ipSubcommand(deps: DbDeps): Command {
  const cmd = new Command('ip');
  describe(cmd, {
    summary: 'Resolve a server name to its IP via .env',
    description: [
      'Tries env keys: <name>, <name with - → _>, UPPERCASE.',
      'IP arguments are returned unchanged (idempotent).',
    ].join('\n'),
    examples: [
      { cmd: 'new-mpu db ip sl-1', note: '→ value of env sl_1 / sl-1 / SL_1' },
      { cmd: 'new-mpu db ip 10.0.0.5', note: '→ 10.0.0.5' },
    ],
  });
  cmd.argument('<name>', 'server name or IP').action((name: string) => {
    deps.print(resolveServerIp(name, deps.env) + '\n');
  });
  return cmd;
}

function querySubcommand(deps: DbDeps): Command {
  const cmd = new Command('query');
  describe(cmd, {
    summary: 'Run SQL against the resolved PG target',
    description: [
      'Resolves <hint> (or explicit flags) to a (server, schema) target and runs the given SQL.',
      '',
      'SQL sources (in order): positional <sql> → stdin (when piped). Without either: error.',
      '',
      'Hint can be: full/partial spreadsheet ID, client_id, IP, server name, title fuzzy.',
      'Mode chosen automatically:',
      '  • client mode (when client_id known): user=client_<id>, password=PG_CLIENT_USER_PASSWORD',
      '  • direct mode (server+schema): user=PG_MY_USER_NAME, password=PG_MY_USER_PASSWORD,',
      '                                  SET search_path TO <schema>',
      '',
      'Required env: PG_DB_NAME, PG_PORT, plus mode-specific creds.',
      '',
      'Per CLAUDE.md feedback: PG queries are NOT cached — always hit the DB.',
    ].join('\n'),
    examples: [
      { cmd: 'new-mpu db query 3377 "SELECT count(*) FROM orders"', note: 'by client_id' },
      { cmd: 'new-mpu db query 1YCG33 "SELECT 1"', note: 'partial ssId prefix' },
      { cmd: 'echo "SELECT now()" | new-mpu db query 3377', note: 'SQL via stdin' },
      { cmd: 'new-mpu db query 3377 "SELECT 1" --tsv', note: 'TSV output' },
      { cmd: 'new-mpu db query --server sl-1 --schema 42 "SELECT 1"' },
    ],
  });
  setProvider(cmd, () => []);
  cmd
    .argument('[hint]', 'spreadsheet ID / client_id / server / title')
    .argument('[sql]', 'SQL to run (or pipe via stdin)')
    .option('-s, --ss <id>', 'spreadsheet ID')
    .option('-c, --client <id>', 'client_id', (v) => Number.parseInt(v, 10))
    .option('--server <name>', 'server name (sl-1) or IP')
    .option('--schema <name>', 'schema name (e.g. 42 → schema_42)')
    .option('--json', 'JSON array of {column: value} (default)')
    .option('--tsv', 'TSV (header + rows)')
    .option('--csv', 'CSV (header + rows, RFC 4180 quoting)')
    .action(
      async (
        hint: string | undefined,
        sql: string | undefined,
        opts: {
          ss?: string;
          client?: number;
          server?: string;
          schema?: string;
          json?: boolean;
          tsv?: boolean;
          csv?: boolean;
        },
      ) => {
        const formats = [opts.json, opts.tsv, opts.csv].filter(Boolean).length;
        if (formats > 1) throw new Error('only one of --json / --tsv / --csv can be set');
        const format: DbOutputFormat = opts.tsv ? 'tsv' : opts.csv ? 'csv' : 'json';

        let actualHint = hint;
        let actualSql = sql;
        const targetExplicit = Boolean(opts.ss || opts.client !== undefined || opts.server);
        if (actualSql === undefined && actualHint !== undefined && targetExplicit) {
          actualSql = actualHint;
          actualHint = undefined;
        }

        let finalSql = actualSql;
        if (!finalSql && !deps.stdinIsTty()) {
          finalSql = (await deps.readStdin()).trim();
        }
        if (!finalSql) {
          throw new Error(
            'no SQL provided. Pass as positional <sql>, or pipe via stdin:\n' +
              '  new-mpu db query 3377 "SELECT 1"\n' +
              '  echo "SELECT 1" | new-mpu db query 3377',
          );
        }

        const target = resolveDbTarget(
          { hint: actualHint, ss: opts.ss, client: opts.client, server: opts.server, schema: opts.schema },
          buildResolveDeps(deps),
        );

        const conn = buildConnection(target, deps.env);
        const schemaForSearchPath = target.kind === 'direct' ? target.schema : undefined;
        const result = await pgQuery(conn.config, schemaForSearchPath, finalSql, deps.pgClientFactory);
        deps.print(formatQueryResult(result, format));
      },
    );
  return cmd;
}

interface PgConnSpec {
  config: { host: string; port: number; user: string; password: string; database: string };
}

function buildConnection(target: DbTarget, env: EnvGetter): PgConnSpec {
  const dbName = required(env, 'PG_DB_NAME');
  const portStr = required(env, 'PG_PORT');
  const port = Number.parseInt(portStr, 10);
  if (!Number.isFinite(port)) throw new Error(`PG_PORT must be a number, got "${portStr}"`);

  if (target.kind === 'client') {
    const password = required(env, 'PG_CLIENT_USER_PASSWORD');
    return {
      config: {
        host: target.ip,
        port,
        user: `client_${target.clientId}`,
        password,
        database: dbName,
      },
    };
  }

  const user = required(env, 'PG_MY_USER_NAME');
  const password = required(env, 'PG_MY_USER_PASSWORD');
  return { config: { host: target.ip, port, user, password, database: dbName } };
}

function required(env: EnvGetter, key: string): string {
  const v = env(key);
  if (!v) throw new Error(`${key} is required (set in process env or ~/.config/mpu/.env)`);
  return v;
}

function formatTargetHuman(t: DbTarget): string {
  if (t.kind === 'client') {
    return `client=${t.clientId}\nserver=${t.server}\nip=${t.ip}\n`;
  }
  return `mode=direct\nserver=${t.server}\nip=${t.ip}\nschema=${t.schema}\n`;
}

export function formatQueryResult(r: PgQueryResult, format: DbOutputFormat): string {
  if (format === 'json') {
    const objs = r.rows.map((row) => {
      const o: Record<string, unknown> = {};
      r.columns.forEach((c, i) => (o[c] = row[i] ?? null));
      return o;
    });
    return JSON.stringify(objs, null, 2) + '\n';
  }
  if (format === 'tsv') {
    const lines = [r.columns.map(escapeTsv).join('\t')];
    for (const row of r.rows) lines.push(row.map(escapeTsv).join('\t'));
    return lines.join('\n') + '\n';
  }
  // csv
  const lines = [r.columns.map(escapeCsv).join(',')];
  for (const row of r.rows) lines.push(row.map(escapeCsv).join(','));
  return lines.join('\n') + '\n';
}

function escapeTsv(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t');
}

function escapeCsv(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replaceAll('"', '""') + '"';
  }
  return s;
}

function defaultDeps(): DbDeps {
  const env = envLookup();
  return {
    getSlSs: () => getDefaultSlSpreadsheets(),
    getSlClients: () => getDefaultSlClients(),
    getCache: () => getDefaultCache(),
    buildSlApi: () => buildSlApi(env.get.bind(env)),
    env: (k) => env.get(k),
    print: (s) => process.stdout.write(s),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
    stdinIsTty: () => Boolean(process.stdin.isTTY),
  };
}

function buildSlApi(getEnv: EnvGetter): SlApi {
  const host = getEnv('NEXT_PUBLIC_SERVER_URL');
  const apiBase = getEnv('BASE_API_URL');
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
      `sl-back credentials missing in env: ${missing.join(', ')}\n` +
        'Set them in process env or in ~/.config/mpu/.env',
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
