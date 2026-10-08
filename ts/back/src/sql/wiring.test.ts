/**
 * Вплетение `mpu sql-ro` в точку входа: собственный `--json`, отказ
 * выброшенного маршрута и печать кандидатов резолва
 * (`docs/specs/sql-ro.md`, `platform/registry.md`, `platform/selector.md`).
 * Прогон идёт через `runCli` — проверяется наблюдаемое поведение CLI, а
 * не внутренности команды.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../entrypoint/mod.ts";
import { makeFakeIo } from "@mpu/command/testing";
import { NO_INVOKE_LOG, type OutputPolicy } from "@mpu/invokelog";
import { type CommandIo, DomainError } from "@mpu/command";
import { openCacheDb } from "@mpu/command/store";

/** Прогон CLI с подсчётом отметок журналу о native-вызове. */
async function cli(argv: readonly string[], io: CommandIo) {
  const out: string[] = [];
  const err: string[] = [];
  const journaled: OutputPolicy[] = [];
  const code = await runCli(
    argv,
    io,
    {
      stdout: (text) => void out.push(text),
      stderr: (text) => void err.push(text),
    },
    {
      nativeCall: (command) => void journaled.push(command),
      note: () => {},
      executedBy: () => {},
      log: NO_INVOKE_LOG,
    },
  );
  return { code, stdout: out.join(""), stderr: err.join(""), journaled };
}

it("sw-селектор: отказ, а не резолв", async () => {
  // Маршрут выброшен целиком (порция 97); алиас распознаётся ради
  // отказа по делу, иначе резолв искал бы клиента с именем `sw`.
  const run = await cli(["sql-ro", "sw", "select 1"], makeFakeIo());
  expect(run.code).toBe(2);
  expect(run.stderr).toBe(
    "mpu sql-ro: маршрут sw выброшен: доступа к контуру воркспейсов нет\n",
  );
  expect(run.stdout).toBe("");
  // Отметка журналу всё равно стоит: вызов был, и запись о нём — тоже.
  expect(run.journaled.length).toBe(1);
});

it("обычный вызов журналируется обвязкой", async () => {
  const io = makeFakeIo({
    envFile: {
      get: () => undefined,
      values: () => ({}),
      // Класс — как у слоя: команда переводит его в ошибку ввода.
      require: (name) => {
        throw new DomainError(`environment variable ${name} is not set.`);
      },
      set: () => Promise.reject(new Error("нет")),
    },
  });
  // Вызов упадёт на конфигурации — отметка журналу всё равно стоит до
  // исполнения, иначе запись о неудачном вызове потерялась бы.
  const run = await cli(["sql-ro", "sl-1", "SELECT 1", "--dry"], io);
  expect(run.journaled.length).toBe(1);
  expect(run.journaled[0].logsOutput).toBe(true);
});

it("вызов без аргументов: код 2 и что делать", async () => {
  const run = await cli(["sql-ro"], makeFakeIo());
  expect(run.code).toBe(2);
  expect(run.stderr).toStrictEqual(
    "mpu sql-ro: нужен target: client_id, sl-N или dev:<client_id>; " +
      "попробуй: mpu sql-ro --help\n",
  );
  expect(run.stdout).toBe("");
});

describe("собственный --json команда разбирает сама", () => {
  const io = makeFakeIo({
    envFile: {
      get: (name) => (({ pg_1: "10.0.0.1" }) as Record<string, string>)[name],
      values: () => ({}),
      require: (name) =>
        name === "pg_1" ? "10.0.0.1" : name === "PG_MY_USER_NAME" ? "u" : "p",
      set: () => Promise.reject(new Error("нет")),
    },
  });

  it("конфликт с --md виден команде", async () => {
    // Перехвати точка входа общий параметр — команда увидела бы только
    // `--md`, и объявленная спекой проверка была бы недостижима.
    const run = await cli(["sql-ro", "sl-1", "SELECT 1", "--json", "--md"], io);
    expect(run.code).toBe(2);
    expect(run.stderr).toBe("mpu sql-ro: --json и --md взаимоисключающие\n");
  });

  it("--dry печатает мету, а не структурный результат", async () => {
    const run = await cli(
      ["sql-ro", "--json", "sl-1", "SELECT 1", "--dry"],
      io,
    );
    expect(run.code).toBe(0);
    // Общий параметр печатал бы сюда результат целиком.
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("mode: read-only\n");
  });
});

it("ошибка резолва: строка ошибки и список кандидатов", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    {
      using seed = openCacheDb(`${dir}/mpu.db`);
      seed.bootstrap();
      // Один клиент на двух серверах — неоднозначный селектор.
      seed.execute(
        "INSERT INTO sl_clients (client_id, server, is_active, is_locked," +
          " is_deleted, synced_at) VALUES (7, 'sl-1', 1, 0, 0, 0)",
      );
      for (const [ssId, server] of [
        ["ss-a", "sl-1"],
        ["ss-b", "sl-2"],
      ]) {
        seed.execute(
          "INSERT INTO sl_spreadsheets (ss_id, client_id, title," +
            " template_name, is_active, server, synced_at)" +
            " VALUES (?, 7, 'Отчёт', NULL, 1, ?, 0)",
          ssId,
          server,
        );
      }
    }
    const io = makeFakeIo({ openCacheDb: () => openCacheDb(`${dir}/mpu.db`) });
    const run = await cli(["sql-ro", "7", "SELECT 1"], io);
    expect(run.code).toBe(2);
    expect(run.stderr).toStrictEqual(
      "mpu sql-ro: ambiguous selector '7' — 2 candidates on different servers\n" +
        '  client_id=7  server=sl-1  title="Отчёт"  spreadsheet_id=ss-a\n' +
        '  client_id=7  server=sl-2  title="Отчёт"  spreadsheet_id=ss-b\n',
    );
    expect(run.stdout).toBe("");
  } finally {
    await rm(dir, { recursive: true });
  }
});
