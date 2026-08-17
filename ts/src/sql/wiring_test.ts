/**
 * Вплетение `mpu sql-ro` в точку входа: мост на прежнюю реализацию,
 * собственный `--json` и печать кандидатов резолва
 * (`docs/specs/sql-ro.md`, `platform/registry.md`, `platform/selector.md`).
 * Прогон идёт через `runCli` — проверяется наблюдаемое поведение CLI, а
 * не внутренности команды.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runCli } from "../entrypoint/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { NO_INVOKE_LOG, type OutputPolicy } from "../invokelog/mod.ts";
import {
  type CommandIo,
  DomainError,
  type LegacyOutcome,
} from "../command/mod.ts";
import { openCacheDb } from "../store/mod.ts";

/** Прогон CLI с подсчётом отметок журналу о native-вызове. */
async function cli(argv: readonly string[], io: CommandIo) {
  const out: string[] = [];
  const err: string[] = [];
  const journaled: OutputPolicy[] = [];
  const code = await runCli(argv, io, {
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
  }, {
    nativeCall: (command) => void journaled.push(command),
    log: NO_INVOKE_LOG,
  });
  return { code, stdout: out.join(""), stderr: err.join(""), journaled };
}

Deno.test("sw-селектор уходит прежней реализации", async (t) => {
  const calls: { bin: string; args: readonly string[] }[] = [];
  const outcome: LegacyOutcome = {
    code: 3,
    stdout: "таблица\n",
    stderr: "шум\n",
  };
  const io = makeFakeIo({
    runLegacy: (bin, args) => {
      calls.push({ bin, args });
      return Promise.resolve(outcome);
    },
  });

  const run = await cli(
    ["sql-ro", "--server", "sl-1", "sw", "select 1", "--нет-такого-флага"],
    io,
  );

  await t.step("argv уходит как есть, потоки и код — насквозь", () => {
    assertEquals(calls.length, 1);
    assertEquals(calls[0].args, [
      "sql-ro",
      "--server",
      "sl-1",
      "sw",
      "select 1",
      "--нет-такого-флага",
    ]);
    assertEquals([run.stdout, run.stderr, run.code], ["таблица\n", "шум\n", 3]);
  });

  await t.step("записи журнала обвязка не создаёт", () => {
    // Её делает сам подпроцесс (`platform/invoke-log.md`, «Разделение
    // моста»): отметка отсюда дала бы вторую запись на один вызов.
    assertEquals(run.journaled, []);
  });
});

Deno.test("обычный вызов журналируется обвязкой", async () => {
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
  assertEquals(run.journaled.length, 1);
  assertEquals(run.journaled[0].logsOutput, true);
});

Deno.test("вызов без аргументов: код 2 и что делать", async () => {
  const run = await cli(["sql-ro"], makeFakeIo());
  assertEquals(run.code, 2);
  assertEquals(
    run.stderr,
    "mpu sql-ro: нужен SELECTOR: client_id, sl-N, dev:<client_id> или " +
      "sw-алиас; попробуй: mpu sql-ro --help\n",
  );
  assertEquals(run.stdout, "");
});

Deno.test("собственный --json команда разбирает сама", async (t) => {
  const io = makeFakeIo({
    envFile: {
      get: (name) => ({ pg_1: "10.0.0.1" } as Record<string, string>)[name],
      values: () => ({}),
      require: (name) =>
        name === "pg_1" ? "10.0.0.1" : name === "PG_MY_USER_NAME" ? "u" : "p",
      set: () => Promise.reject(new Error("нет")),
    },
  });

  await t.step("конфликт с --md виден команде", async () => {
    // Перехвати точка входа общий параметр — команда увидела бы только
    // `--md`, и объявленная спекой проверка была бы недостижима.
    const run = await cli(
      ["sql-ro", "sl-1", "SELECT 1", "--json", "--md"],
      io,
    );
    assertEquals(run.code, 2);
    assertEquals(run.stderr, "mpu sql-ro: --json и --md взаимоисключающие\n");
  });

  await t.step("--dry печатает мету, а не структурный результат", async () => {
    const run = await cli(
      ["sql-ro", "--json", "sl-1", "SELECT 1", "--dry"],
      io,
    );
    assertEquals(run.code, 0);
    // Общий параметр печатал бы сюда результат целиком.
    assertEquals(run.stdout, "");
    assertStringIncludes(run.stderr, "mode: read-only\n");
  });
});

Deno.test("ошибка резолва: строка ошибки и список кандидатов", async () => {
  const dir = await Deno.makeTempDir();
  try {
    {
      using seed = openCacheDb(`${dir}/mpu.db`);
      seed.bootstrap();
      // Один клиент на двух серверах — неоднозначный селектор.
      seed.execute(
        "INSERT INTO sl_clients (client_id, server, is_active, is_locked," +
          " is_deleted, synced_at) VALUES (7, 'sl-1', 1, 0, 0, 0)",
      );
      for (const [ssId, server] of [["ss-a", "sl-1"], ["ss-b", "sl-2"]]) {
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
    assertEquals(run.code, 2);
    assertEquals(
      run.stderr,
      "mpu sql-ro: ambiguous selector '7' — 2 candidates on different servers\n" +
        '  client_id=7  server=sl-1  title="Отчёт"  spreadsheet_id=ss-a\n' +
        '  client_id=7  server=sl-2  title="Отчёт"  spreadsheet_id=ss-b\n',
    );
    assertEquals(run.stdout, "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
