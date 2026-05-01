import { describe, it, expect } from '@jest/globals';
import { Command } from 'commander';
import { dbCommand, formatQueryResult, type DbDeps } from '../src/commands/db.js';
import type { PgClientFactory } from '../src/lib/pgclient.js';
import { openDb } from '../src/lib/db.js';
import { Config } from '../src/lib/config.js';
import { Cache } from '../src/lib/cache.js';
import { SlSpreadsheets } from '../src/lib/sl-spreadsheets.js';
import { SlClients } from '../src/lib/sl-clients.js';

function makeDeps(over: Partial<DbDeps> = {}): {
  deps: DbDeps;
  output: string[];
  ssStore: SlSpreadsheets;
  clientsStore: SlClients;
  pgQueries: { conn: unknown; queries: string[] }[];
} {
  const db = openDb(':memory:');
  const config = new Config(db);
  const cache = new Cache(db, config);
  const ssStore = new SlSpreadsheets(db);
  const clientsStore = new SlClients(db);
  const output: string[] = [];

  const env: Record<string, string> = {
    PG_DB_NAME: 'wbplus',
    PG_PORT: '5432',
    PG_CLIENT_USER_PASSWORD: 'cpw',
    PG_MY_USER_NAME: 'me',
    PG_MY_USER_PASSWORD: 'mpw',
    'sl-1': '10.0.0.1',
    'sl-2': '10.0.0.2',
  };

  const pgQueries: { conn: unknown; queries: string[] }[] = [];
  const factory: PgClientFactory = (cfg) => {
    const log: string[] = [];
    pgQueries.push({ conn: cfg, queries: log });
    return {
      connect: async () => {},
      query: async (sql: string) => {
        log.push(sql);
        if (sql.startsWith('SET search_path')) return { fields: [], rows: [] };
        return {
          fields: [{ name: 'n' }, { name: 's' }],
          rows: [{ n: 1, s: 'a' }, { n: 2, s: 'b' }],
        };
      },
      end: async () => {},
    };
  };

  const deps: DbDeps = {
    getSlSs: () => ssStore,
    getSlClients: () => clientsStore,
    getCache: () => cache,
    buildSlApi: () => {
      throw new Error('SlApi not configured in this test');
    },
    env: (k) => env[k],
    pgClientFactory: factory,
    print: (s) => {
      output.push(s);
    },
    readStdin: async () => '',
    stdinIsTty: () => true,
    ...over,
  };

  return { deps, output, ssStore, clientsStore, pgQueries };
}

async function run(args: string[], deps: DbDeps): Promise<void> {
  const root = new Command();
  root.exitOverride();
  root.addCommand(dbCommand(deps));
  await root.parseAsync(['node', 'mpu', 'db', ...args]);
}

describe('db ip', () => {
  it('Проверяет: имя сервера резолвится в IP через env', async () => {
    const { deps, output } = makeDeps();
    await run(['ip', 'sl-1'], deps);
    expect(output.join('').trim()).toBe('10.0.0.1');
  });

  it('Проверяет: IP идёт обратно как есть', async () => {
    const { deps, output } = makeDeps();
    await run(['ip', '192.168.1.1'], deps);
    expect(output.join('').trim()).toBe('192.168.1.1');
  });
});

describe('db server', () => {
  it('Проверяет: по client_id печатает client+server+ip', async () => {
    const { deps, output, clientsStore } = makeDeps();
    clientsStore.replaceAll([
      { clientId: 3377, server: 'sl-1', isActive: true, isLocked: false, isDeleted: false },
    ]);
    await run(['server', '3377', '--json'], deps);
    expect(JSON.parse(output.join(''))).toEqual({
      kind: 'client',
      clientId: 3377,
      server: 'sl-1',
      ip: '10.0.0.1',
    });
  });

  it('Проверяет: по spreadsheet_id', async () => {
    const { deps, output, ssStore, clientsStore } = makeDeps();
    ssStore.replaceAll([
      {
        ssId: '1YCG33sFWPditVaTNOdHUaWNtW3o-kj7wsmtx76jGEvs',
        clientId: 3377,
        title: 'PrintPortal | 10X WB',
        templateName: 'wb10xMain',
        isActive: true,
        server: null,
      },
    ]);
    clientsStore.replaceAll([
      { clientId: 3377, server: 'sl-1', isActive: true, isLocked: false, isDeleted: false },
    ]);
    await run(['server', '1YCG33sFWPditVaTNOdHUaWNtW3o-kj7wsmtx76jGEvs', '--json'], deps);
    expect(JSON.parse(output.join('')).clientId).toBe(3377);
  });
});

describe('db query', () => {
  it('Проверяет: client mode подключается как client_<id>, без SET search_path', async () => {
    const { deps, output, clientsStore, pgQueries } = makeDeps();
    clientsStore.replaceAll([
      { clientId: 3377, server: 'sl-1', isActive: true, isLocked: false, isDeleted: false },
    ]);
    await run(['query', '3377', 'SELECT * FROM orders LIMIT 2'], deps);
    expect(pgQueries).toHaveLength(1);
    const q = pgQueries[0]!;
    expect((q.conn as { user: string; host: string }).user).toBe('client_3377');
    expect((q.conn as { host: string }).host).toBe('10.0.0.1');
    expect(q.queries).toEqual(['SELECT * FROM orders LIMIT 2']);
    expect(JSON.parse(output.join(''))).toEqual([
      { n: 1, s: 'a' },
      { n: 2, s: 'b' },
    ]);
  });

  it('Проверяет: direct mode (--server + --schema) делает SET search_path', async () => {
    const { deps, pgQueries } = makeDeps();
    await run(['query', '--server', 'sl-2', '--schema', '42', 'SELECT 1'], deps);
    const q = pgQueries[0]!;
    expect((q.conn as { user: string }).user).toBe('me');
    expect(q.queries[0]).toMatch(/SET search_path TO "schema_42"/);
    expect(q.queries[1]).toBe('SELECT 1');
  });

  it('Проверяет: SQL читается из stdin когда не TTY и позиционно нет', async () => {
    const { deps, pgQueries, clientsStore } = makeDeps({
      stdinIsTty: () => false,
      readStdin: async () => 'SELECT now()',
    });
    clientsStore.replaceAll([
      { clientId: 3377, server: 'sl-1', isActive: true, isLocked: false, isDeleted: false },
    ]);
    await run(['query', '3377'], deps);
    expect(pgQueries[0]!.queries).toEqual(['SELECT now()']);
  });

  it('Проверяет: без SQL и stdin — понятная ошибка', async () => {
    const { deps, clientsStore } = makeDeps();
    clientsStore.replaceAll([
      { clientId: 3377, server: 'sl-1', isActive: true, isLocked: false, isDeleted: false },
    ]);
    await expect(run(['query', '3377'], deps)).rejects.toThrow(/no SQL provided/i);
  });

  it('Проверяет: --tsv формат — заголовок + строки', async () => {
    const { deps, output, clientsStore } = makeDeps();
    clientsStore.replaceAll([
      { clientId: 3377, server: 'sl-1', isActive: true, isLocked: false, isDeleted: false },
    ]);
    await run(['query', '3377', 'SELECT 1', '--tsv'], deps);
    const lines = output.join('').trim().split('\n');
    expect(lines[0]).toBe('n\ts');
    expect(lines.slice(1).sort()).toEqual(['1\ta', '2\tb']);
  });

  it('Проверяет: больше одного формата — ошибка', async () => {
    const { deps, clientsStore } = makeDeps();
    clientsStore.replaceAll([
      { clientId: 3377, server: 'sl-1', isActive: true, isLocked: false, isDeleted: false },
    ]);
    await expect(
      run(['query', '3377', 'SELECT 1', '--json', '--tsv'], deps),
    ).rejects.toThrow(/only one of/i);
  });
});

describe('formatQueryResult', () => {
  const sample = {
    columns: ['id', 'name', 'note'],
    rows: [
      [1, 'Alice', null],
      [2, 'Bob, Jr.', 'has, comma'],
      [3, 'Quoted "X"', 'line\nbreak'],
    ],
  };

  it('Проверяет: JSON — массив объектов column→value, null сохраняется', () => {
    const out = formatQueryResult(sample, 'json');
    expect(JSON.parse(out)).toEqual([
      { id: 1, name: 'Alice', note: null },
      { id: 2, name: 'Bob, Jr.', note: 'has, comma' },
      { id: 3, name: 'Quoted "X"', note: 'line\nbreak' },
    ]);
  });

  it('Проверяет: TSV — escape для \\n/\\t/\\r/\\\\', () => {
    const out = formatQueryResult(sample, 'tsv').trim().split('\n');
    expect(out[0]).toBe('id\tname\tnote');
    expect(out[3]).toBe('3\tQuoted "X"\tline\\nbreak');
  });

  it('Проверяет: CSV — RFC 4180 quoting (запятая, кавычки, перевод строки)', () => {
    const out = formatQueryResult(sample, 'csv').trim().split('\n');
    expect(out[0]).toBe('id,name,note');
    expect(out[2]).toBe('2,"Bob, Jr.","has, comma"');
    expect(out[3]).toMatch(/^3,"Quoted ""X""","line/);
  });
});
