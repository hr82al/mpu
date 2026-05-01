import { describe, it, expect, jest } from '@jest/globals';
import { pgQuery, type PgClientFactory } from '../src/lib/pgclient.js';

interface FakeQueryResult {
  fields: { name: string }[];
  rows: Record<string, unknown>[];
}

class FakeClient {
  static instances: FakeClient[] = [];
  connectCalls = 0;
  endCalls = 0;
  queries: string[] = [];
  scriptedResults: FakeQueryResult[] = [];
  connectError: Error | null = null;

  async connect(): Promise<void> {
    this.connectCalls++;
    if (this.connectError) throw this.connectError;
  }

  async query(sql: string): Promise<FakeQueryResult> {
    this.queries.push(sql);
    return this.scriptedResults.shift() ?? { fields: [], rows: [] };
  }

  async end(): Promise<void> {
    this.endCalls++;
  }
}

function makeFactory(setup?: (c: FakeClient) => void): PgClientFactory {
  return jest.fn((..._cfg: Parameters<PgClientFactory>) => {
    const c = new FakeClient();
    FakeClient.instances.push(c);
    setup?.(c);
    return c as unknown as ReturnType<PgClientFactory>;
  }) as unknown as PgClientFactory;
}

const conn = { host: '1.2.3.4', port: 5432, user: 'u', password: 'p', database: 'db' };

describe('pgQuery', () => {
  it('Проверяет: connect → query → end', async () => {
    FakeClient.instances = [];
    const factory = makeFactory((c) => {
      c.scriptedResults.push({ fields: [{ name: 'a' }, { name: 'b' }], rows: [{ a: 1, b: 2 }] });
    });
    const r = await pgQuery(conn, undefined, 'SELECT 1', factory);
    expect(r).toEqual({ columns: ['a', 'b'], rows: [[1, 2]] });
    const c = FakeClient.instances[0]!;
    expect(c.connectCalls).toBe(1);
    expect(c.queries).toEqual(['SELECT 1']);
    expect(c.endCalls).toBe(1);
  });

  it('Проверяет: schema → SET search_path выполняется до основного запроса', async () => {
    FakeClient.instances = [];
    const factory = makeFactory((c) => {
      c.scriptedResults.push({ fields: [], rows: [] }); // SET
      c.scriptedResults.push({ fields: [{ name: 'x' }], rows: [{ x: 1 }] });
    });
    await pgQuery(conn, 'schema_42', 'SELECT 1', factory);
    const c = FakeClient.instances[0]!;
    expect(c.queries[0]).toMatch(/SET search_path/i);
    expect(c.queries[0]).toMatch(/schema_42/);
    expect(c.queries[1]).toBe('SELECT 1');
  });

  it('Проверяет: end вызывается даже при ошибке запроса', async () => {
    FakeClient.instances = [];
    class FailingClient extends FakeClient {
      override async query(): Promise<FakeQueryResult> {
        throw new Error('boom');
      }
    }
    const factory = jest.fn(() => {
      const c = new FailingClient();
      FakeClient.instances.push(c);
      return c as unknown as ReturnType<PgClientFactory>;
    }) as unknown as PgClientFactory;
    await expect(pgQuery(conn, undefined, 'SELECT bad', factory)).rejects.toThrow(/boom/);
    expect(FakeClient.instances[0]!.endCalls).toBe(1);
  });

  it('Проверяет: при ошибке connect — end не вызывается', async () => {
    FakeClient.instances = [];
    const factory = makeFactory((c) => {
      c.connectError = new Error('connection refused');
    });
    await expect(pgQuery(conn, undefined, 'SELECT 1', factory)).rejects.toThrow(/connection/);
    expect(FakeClient.instances[0]!.endCalls).toBe(0);
  });
});
