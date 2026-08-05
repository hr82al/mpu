/**
 * Тесты команды `mpu update` (`docs/specs/update.md`): формы строк
 * вывода дословно, `--quiet`, прогрев Loki и отказ недоступного main.
 *
 * Синк работает через фейковый исполнитель PG (порт `sync.ts`), а Loki
 * — через фейковый сервер на петле: наружу тесты не ходят.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { openCacheDb } from "../store/mod.ts";
import type { CacheDb, CommandIo, EnvFile } from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { runCli } from "../entrypoint/mod.ts";
import type { PgRow } from "./cache.ts";
import type { OpenPgSession, PgSession } from "./sync.ts";
import {
  CONNECT_TIMEOUT_MS,
  QUERY_TIMEOUT_MS,
  runUpdate,
  updateCommand,
  type UpdateLimits,
  type UpdateResult,
} from "./mod.ts";

/** Пределы тестов: сеть здесь фейковая, ждать продуктовые нечего. */
const LIMITS: UpdateLimits = {
  pg: { connectMs: 200, queryMs: 200 },
  loki: { headersTimeoutMs: 500, totalTimeoutMs: 2_000 },
};

/** Ответ series API Loki: два хоста, две пары. */
const SERIES = {
  status: "success",
  data: [
    { host: "sl-1", compose_service: "cli" },
    { host: "sl-2", compose_service: "loader" },
  ],
};

/** Выборки одного сервера; отсутствующая отдаёт пустой список. */
interface FakeServer {
  readonly clients?: readonly PgRow[];
  readonly spreadsheets?: readonly PgRow[] | Error;
  readonly wbSids?: readonly PgRow[];
}

/** Фейковый PG: сервера нет в записи — подключение к нему падает. */
function fakePg(servers: Readonly<Record<number, FakeServer>>): OpenPgSession {
  return (serverNumber) => {
    const server = servers[serverNumber];
    if (server === undefined) {
      return Promise.reject(new Error(`нет соединения с sl-${serverNumber}`));
    }
    const answer = (rows: readonly PgRow[] | Error | undefined) => () =>
      rows instanceof Error
        ? Promise.reject(rows)
        : Promise.resolve(rows ?? []);
    const session: PgSession = {
      clients: answer(server.clients),
      spreadsheets: answer(server.spreadsheets),
      wbSids: answer(server.wbSids),
      close: () => Promise.resolve(),
    };
    return Promise.resolve(session);
  };
}

function client(id: number, server: string): PgRow {
  return { id, server, is_active: true, is_locked: false, is_deleted: false };
}

function envFileFake(values: Readonly<Record<string, string>> = {}): EnvFile {
  return {
    get: (name) => values[name],
    require: () => {
      throw new Error("envFile.require must not be touched");
    },
    set: () => {
      throw new Error("envFile.set must not be touched");
    },
    values: () => ({ ...values }),
  };
}

/** Фейковый Loki на петле; гасить `await stop()` в `finally`. */
function fakeLoki(): {
  readonly baseUrl: string;
  readonly stop: () => Promise<void>;
} {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    () => Response.json(SERIES),
  );
  return {
    baseUrl: `http://127.0.0.1:${server.addr.port}`,
    stop: () => server.shutdown(),
  };
}

interface Run {
  /** Путь кэш-БД: команда открывает её сама, своим хендлом. */
  readonly dbPath: string;
  readonly io: CommandIo;
  readonly progress: readonly string[];
}

async function withRun(
  values: Readonly<Record<string, string>>,
  fn: (run: Run) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    const dbPath = `${dir}/mpu.db`;
    const progress: string[] = [];
    const io = makeFakeIo({
      openCacheDb: () => openCacheDb(dbPath),
      envFile: envFileFake(values),
      progress: (line) => void progress.push(line),
    });
    await fn({ dbPath, io, progress });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Число строк таблицы кэша; хендл свой — команда свой уже закрыла. */
function count(dbPath: string, table: string): number {
  using db: CacheDb = openCacheDb(dbPath);
  const rows = db.query(`SELECT count(*) AS n FROM ${table}`);
  return Number(rows[0].n);
}

Deno.test("сводка: форма строк вывода дословно", async (t) => {
  const result: UpdateResult = {
    clients: 12,
    spreadsheets: 34,
    servers: 3,
    wbSids: 5,
    tookSeconds: 1.2345,
    failedServers: [],
    loki: { skipped: null, hosts: 7, pairs: 9 },
  };
  const summary = "clients: 12 rows, spreadsheets: 34 rows from 3 servers, " +
    "wb sids: 5 rows, took 1.23s\n";

  await t.step("сводка и строка Loki", () => {
    assertEquals(
      updateCommand.renderResult(result, []),
      `${summary}loki: 7 hosts, 9 (host, service) пар\n`,
    );
  });

  await t.step("прогрев Loki пропущен — только сводка", () => {
    assertEquals(
      updateCommand.renderResult(
        { ...result, loki: { skipped: "HTTP 503", hosts: null, pairs: null } },
        [],
      ),
      summary,
    );
  });

  await t.step("--quiet: печати нет вовсе", () => {
    assertEquals(updateCommand.renderResult(result, ["--quiet"]), "");
  });
});

Deno.test("упавшие инстансы: одна строка warning, серверы по возрастанию", async () => {
  await withRun({}, async ({ io, progress }) => {
    // Клиенты перечислены так, что номера серверов идут по убыванию:
    // порядок предупреждения задаёт синк, а не порядок выборки.
    const openPg = fakePg({
      0: {
        clients: [
          client(103, "sl-3"),
          client(101, "sl-1"),
          client(102, "sl-2"),
        ],
      },
      2: { spreadsheets: new Error("timeout\nвторая строка") },
    });
    const result = await runUpdate({ quiet: false }, io, {
      openPg,
      limits: LIMITS,
    });

    assertEquals(progress, [
      "warning: failed to query servers: sl-1 (нет соединения с sl-1), " +
      "sl-2 (timeout), sl-3 (нет соединения с sl-3)",
      "loki: пропущено (LOKI_URL не задан)",
    ]);
    assertEquals(result.failedServers, [
      { server: "sl-1", reason: "нет соединения с sl-1" },
      { server: "sl-2", reason: "timeout" },
      { server: "sl-3", reason: "нет соединения с sl-3" },
    ]);
    assertEquals(result.servers, 0);
  });
});

Deno.test("прогрев Loki: строка сводки и записи в кэш", async () => {
  const loki = fakeLoki();
  try {
    await withRun(
      { LOKI_URL: loki.baseUrl },
      async ({ dbPath, io, progress }) => {
        const openPg = fakePg({ 0: { clients: [client(101, "sl-0")] } });
        const result = await runUpdate({ quiet: false }, io, {
          openPg,
          limits: LIMITS,
        });

        assertEquals(result.loki, { skipped: null, hosts: 2, pairs: 2 });
        assertEquals(progress, []);
        assertEquals(count(dbPath, "loki_hosts"), 2);
        assertEquals(count(dbPath, "loki_services_by_host"), 2);
      },
    );
  } finally {
    await loki.stop();
  }
});

Deno.test("--quiet: ни строки вывода, но записи выполнены полностью", async () => {
  const loki = fakeLoki();
  try {
    await withRun(
      { LOKI_URL: loki.baseUrl },
      async ({ dbPath, io, progress }) => {
        const openPg = fakePg({
          0: {
            clients: [client(101, "sl-1"), client(102, "sl-7")],
            wbSids: [{ client_id: 101, sid: "sid-a" }],
          },
          1: {
            spreadsheets: [{
              spreadsheet_id: "ss1",
              client_id: 101,
              title: null,
              template_name: null,
              is_active: true,
            }],
          },
        });
        const result = await runUpdate({ quiet: true }, io, {
          openPg,
          limits: LIMITS,
        });

        // Печати нет ни в одном канале: ни warning об упавшем sl-7, ни
        // строки Loki, ни сводки.
        assertEquals(progress, []);
        assertEquals(updateCommand.renderResult(result, ["--quiet"]), "");
        // А записи — все: снапшот и прогрев Loki.
        assertEquals(count(dbPath, "sl_clients"), 2);
        assertEquals(count(dbPath, "sl_spreadsheets"), 1);
        assertEquals(count(dbPath, "sl_wb_sids"), 1);
        assertEquals(count(dbPath, "loki_hosts"), 2);
        assertEquals(result.failedServers, [{
          server: "sl-7",
          reason: "нет соединения с sl-7",
        }]);
      },
    );
  } finally {
    await loki.stop();
  }
});

Deno.test("недоступный main: отказ одной строкой, exit 1", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const io = makeFakeIo({
      openCacheDb: () => openCacheDb(`${dir}/mpu.db`),
      envFile: envFileFake({}),
    });
    const out: string[] = [];
    const err: string[] = [];
    // Через точку входа целиком: `pg_0` в env-файле нет, поэтому в PG не
    // уходит ни байта, а команда отказывает так же, как при недоступном
    // сервере (`update.md`, «Известные отклонения»).
    const code = await runCli(["update"], io, {
      stdout: (text) => void out.push(text),
      stderr: (text) => void err.push(text),
    });

    assertEquals(code, 1);
    assertEquals(out.join(""), "");
    assertEquals(
      err.join(""),
      "mpu update: main (sl-0) недоступен: pg_0 не задан в env-файле\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("справка называет пределы времени", async () => {
  const io = makeFakeIo();
  const out: string[] = [];
  const code = await runCli(["update", "--help"], io, {
    stdout: (text) => void out.push(text),
    stderr: () => {},
  });

  assertEquals(code, 0);
  const help = out.join("");
  assertStringIncludes(help, `${CONNECT_TIMEOUT_MS} ms на соединение`);
  assertStringIncludes(help, `${QUERY_TIMEOUT_MS} ms на запрос`);
  assertStringIncludes(help, "--quiet");
});
