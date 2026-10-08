/**
 * Тесты команды `mpu update` (`docs/specs/update.md`): формы строк
 * вывода дословно, `--quiet`, прогрев Loki. Отказ недоступного main и
 * справка идут через точку входа потребителя — их тесты в `ts/`
 * (`back/src/entrypoint/update_wiring.test.ts`).
 *
 * Синк работает через фейковый исполнитель PG (порт `sync.ts`), а Loki
 * — через фейковый сервер на петле: наружу тесты не ходят.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type FakeHttp, serveFetch } from "@mpu/testing";
import { openCacheDb } from "@mpu/command/store";
import type { CacheDb, CommandIo, EnvFile } from "@mpu/command";
import { makeFakeIo } from "@mpu/command/testing";
import type { PgRow } from "./cache.ts";
import type { OpenPgSession, PgSession } from "./sync.ts";
import {
  runUpdate,
  updateCommand,
  type UpdateLimits,
  type UpdateResult,
} from "./cmd_update.ts";

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
function fakeLoki(): Promise<FakeHttp> {
  return serveFetch(() => Response.json(SERIES));
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
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
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
    await rm(dir, { recursive: true });
  }
}

/** Число строк таблицы кэша; хендл свой — команда свой уже закрыла. */
function count(dbPath: string, table: string): number {
  using db: CacheDb = openCacheDb(dbPath);
  const rows = db.query(`SELECT count(*) AS n FROM ${table}`);
  return Number(rows[0].n);
}

describe("сводка: форма строк вывода дословно", () => {
  const result: UpdateResult = {
    clients: 12,
    spreadsheets: 34,
    servers: 3,
    wbSids: 5,
    tookSeconds: 1.2345,
    failedServers: [],
    loki: { skipped: null, hosts: 7, pairs: 9 },
  };
  const summary =
    "clients: 12 rows, spreadsheets: 34 rows from 3 servers, " +
    "wb sids: 5 rows, took 1.23s\n";

  it("сводка и строка Loki", () => {
    expect(updateCommand.renderResult(result, [])).toStrictEqual(
      `${summary}loki: 7 hosts, 9 (host, service) пар\n`,
    );
  });

  it("прогрев Loki пропущен — только сводка", () => {
    expect(
      updateCommand.renderResult(
        { ...result, loki: { skipped: "HTTP 503", hosts: null, pairs: null } },
        [],
      ),
    ).toStrictEqual(summary);
  });

  it("--quiet: печати нет вовсе", () => {
    expect(updateCommand.renderResult(result, ["--quiet"])).toBe("");
  });
});

it("упавшие инстансы: одна строка warning, серверы по возрастанию", async () => {
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

    expect(progress).toStrictEqual([
      "warning: failed to query servers: sl-1 (нет соединения с sl-1), " +
        "sl-2 (timeout), sl-3 (нет соединения с sl-3)",
      "loki: пропущено (LOKI_URL не задан)",
    ]);
    expect(result.failedServers).toStrictEqual([
      { server: "sl-1", reason: "нет соединения с sl-1" },
      { server: "sl-2", reason: "timeout" },
      { server: "sl-3", reason: "нет соединения с sl-3" },
    ]);
    expect(result.servers).toBe(0);
  });
});

it("прогрев Loki: строка сводки и записи в кэш", async () => {
  const loki = await fakeLoki();
  try {
    await withRun(
      { LOKI_URL: loki.baseUrl },
      async ({ dbPath, io, progress }) => {
        const openPg = fakePg({ 0: { clients: [client(101, "sl-0")] } });
        const result = await runUpdate({ quiet: false }, io, {
          openPg,
          limits: LIMITS,
        });

        expect(result.loki).toStrictEqual({
          skipped: null,
          hosts: 2,
          pairs: 2,
        });
        expect(progress).toStrictEqual([]);
        expect(count(dbPath, "loki_hosts")).toBe(2);
        expect(count(dbPath, "loki_services_by_host")).toBe(2);
      },
    );
  } finally {
    await loki.stop();
  }
});

it("--quiet: ни строки вывода, но записи выполнены полностью", async () => {
  const loki = await fakeLoki();
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
            spreadsheets: [
              {
                spreadsheet_id: "ss1",
                client_id: 101,
                title: null,
                template_name: null,
                is_active: true,
              },
            ],
          },
        });
        const result = await runUpdate({ quiet: true }, io, {
          openPg,
          limits: LIMITS,
        });

        // Печати нет ни в одном канале: ни warning об упавшем sl-7, ни
        // строки Loki, ни сводки.
        expect(progress).toStrictEqual([]);
        expect(updateCommand.renderResult(result, ["--quiet"])).toBe("");
        // А записи — все: снапшот и прогрев Loki.
        expect(count(dbPath, "sl_clients")).toBe(2);
        expect(count(dbPath, "sl_spreadsheets")).toBe(1);
        expect(count(dbPath, "sl_wb_sids")).toBe(1);
        expect(count(dbPath, "loki_hosts")).toBe(2);
        expect(result.failedServers).toStrictEqual([
          {
            server: "sl-7",
            reason: "нет соединения с sl-7",
          },
        ]);
      },
    );
  } finally {
    await loki.stop();
  }
});
