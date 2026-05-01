import pg from 'pg';

export interface PgConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface PgQueryResult {
  columns: string[];
  rows: unknown[][];
}

export interface PgClientLike {
  connect(): Promise<void>;
  query(sql: string): Promise<{ fields: { name: string }[]; rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export type PgClientFactory = (cfg: PgConnection) => PgClientLike;

const defaultFactory: PgClientFactory = (cfg) => {
  const c = new pg.Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
  });
  return {
    connect: async () => {
      await c.connect();
    },
    query: async (sql: string) => {
      const r = await c.query(sql);
      return { fields: r.fields, rows: r.rows as Record<string, unknown>[] };
    },
    end: () => c.end(),
  };
};

function quoteIdent(name: string): string {
  return '"' + name.replaceAll('"', '""') + '"';
}

export async function pgQuery(
  conn: PgConnection,
  schema: string | undefined,
  sql: string,
  factory: PgClientFactory = defaultFactory,
): Promise<PgQueryResult> {
  const client = factory(conn);
  await client.connect();
  try {
    if (schema) {
      await client.query(`SET search_path TO ${quoteIdent(schema)}`);
    }
    const r = await client.query(sql);
    const columns = r.fields.map((f) => f.name);
    const rows = r.rows.map((row) => columns.map((c) => row[c] ?? null));
    return { columns, rows };
  } finally {
    await client.end();
  }
}
