/**
 * Команда `mpu sql` (`docs/specs/sql.md`): контракт общий с `sql-ro`,
 * отличий четыре. Здесь проверяются именно они — пишущая сессия, отказ
 * от проверки только-чтения, мета-блок без строки режима и своя политика
 * публикации; остальное закрыто тестами общего хода (`cmd_sql_ro_test.ts`).
 *
 * Живой мутации в тестах нет по построению (спека, «Инварианты»):
 * транзакционность проверяется последовательностью операторов, ушедших
 * драйверу, — `pg_test.ts`.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  DomainError,
  type EnvFile,
  formatCommandError,
  VerbatimError,
} from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { sqlCommand } from "./cmd_sql.ts";
import type { SqlOutcome } from "./render.ts";
import { runSql, type SqlArgs } from "./run.ts";
import { DbError, type OpenSession } from "./session.ts";

const PG_HOST = "10.0.0.1";

const ENV: Readonly<Record<string, string>> = {
  pg_3: PG_HOST,
  PG_MY_USER_NAME: "u",
  PG_MY_USER_PASSWORD: "p",
};

/** Аргументы вызова: всё, кроме названного, — умолчания схемы. */
function args(overrides: Partial<SqlArgs> & { selector: string }): SqlArgs {
  return {
    sql: undefined,
    server: undefined,
    dry: false,
    json: false,
    md: false,
    verbose: false,
    ...overrides,
  };
}

const envFile: EnvFile = {
  get: (name) => ENV[name],
  values: () => ({ ...ENV }),
  require: (name) => {
    const value = ENV[name];
    if (value !== undefined) return value;
    throw new DomainError(`environment variable ${name} is not set.`);
  },
  set: () => Promise.reject(new Error("запись env-файла не ожидается")),
};

const DONE_ZERO: SqlOutcome = { kind: "done", rowcount: 0 };

/** Подставная сессия: помнит запросы и цели подключения. */
function fakeSessions(answer: (text: string) => SqlOutcome | Error) {
  const asked: string[] = [];
  const ask = (text: string) => {
    asked.push(text);
    const reply = answer(text);
    return reply instanceof Error
      ? Promise.reject(reply)
      : Promise.resolve(reply);
  };
  const open: OpenSession = () =>
    Promise.resolve({
      query: ask,
      run: ask,
      close: () => Promise.resolve(),
    });
  return { open, asked };
}

/** Порт исполнения и накопленный stderr. */
function harness() {
  const progress: string[] = [];
  const io = makeFakeIo({
    envFile,
    progress: (line: string) => progress.push(line),
    openCacheDb: () => {
      throw new Error("кэш-БД открываться не должна");
    },
  });
  return { io, progress, stderr: () => progress.map((l) => `${l}\n`).join("") };
}

async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/sql/${name}`, import.meta.url),
  );
}

Deno.test("мета-блок пишущей сессии: строки mode нет", async () => {
  const sessions = fakeSessions(() => DONE_ZERO);
  const { io, stderr } = harness();
  await runSql(
    args({
      selector: "нет-такого",
      server: "sl-3",
      sql: "SELECT 1",
      dry: true,
      verbose: true,
    }),
    io,
    { mode: "write", openSession: sessions.open },
  );
  assertEquals(
    stderr(),
    (await golden("dry-v-server-stderr.txt"))
      .replaceAll("<pg_host>", PG_HOST)
      .replaceAll("<N>", "3"),
  );
  // `--dry` не открывает соединений — единственный режим, безопасный по
  // построению (спека, «Инварианты»).
  assertEquals(sessions.asked, []);
});

Deno.test("сессия пишущая: только-чтение на соединении не проверяется", async () => {
  const sessions = fakeSessions(() => DONE_ZERO);
  const { io } = harness();
  await runSql(
    args({ selector: "sl-3", sql: "UPDATE t SET a = 1 WHERE 1=0" }),
    io,
    { mode: "write", openSession: sessions.open },
  );
  // Служебного `SELECT current_setting(...)` у `mpu sql` нет: запрет
  // записи он не ставит и подтверждать ему нечего.
  assertEquals(sessions.asked, ["UPDATE t SET a = 1 WHERE 1=0"]);
});

Deno.test("успех записи без набора строк — эталоны канала", async (t) => {
  const sessions = fakeSessions(() => DONE_ZERO);
  const { io } = harness();
  const argv = ["sl-3", "UPDATE t SET a = 1 WHERE 1=0"];
  const result = await runSql(
    args({ selector: argv[0], sql: argv[1] }),
    io,
    { mode: "write", openSession: sessions.open },
  );

  await t.step("ok-rowcount-stdout.txt", async () => {
    assertEquals(
      sqlCommand.renderResult(result, argv),
      await golden("ok-rowcount-stdout.txt"),
    );
  });

  await t.step("ok-rowcount-json-stdout.txt", async () => {
    assertEquals(
      sqlCommand.renderResult(result, [...argv, "--json"]),
      await golden("ok-rowcount-json-stdout.txt"),
    );
  });
});

Deno.test("--dry: намерение без вывода в stdout", async () => {
  const sessions = fakeSessions(() => DONE_ZERO);
  const { io } = harness();
  const argv = ["sl-3", "DELETE FROM t", "--dry"];
  const result = await runSql(
    args({ selector: argv[0], sql: argv[1], dry: true }),
    io,
    { mode: "write", openSession: sessions.open },
  );
  // Результата нет — печатать нечего: намерение уже ушло в stderr
  // мета-блоком.
  assertEquals(sqlCommand.renderResult(result, argv), "");
  assertEquals(sessions.asked, []);
});

Deno.test("ошибка БД: текст сервера как есть, без своих подсказок", async () => {
  const server = 'syntax error at or near "SELEC"\n' +
    "LINE 1: SELEC 1\n" +
    "        ^";
  const sessions = fakeSessions(() => new DbError(server));
  const { io } = harness();
  const err = await assertRejects(
    () =>
      runSql(args({ selector: "sl-3", sql: "SELEC 1" }), io, {
        mode: "write",
        openSession: sessions.open,
      }),
    VerbatimError,
  );
  assertEquals(
    `${formatCommandError("sql", err)}\n`,
    await golden("db-error-stderr.txt"),
  );
});

Deno.test("объявление команды: политика, мост и предел описания", async (t) => {
  await t.step("мутирующая команда — класс rw", () => {
    assertEquals(sqlCommand.path, ["sql"]);
    assertEquals(sqlCommand.policy, "rw");
    assertEquals(sqlCommand.errorName, "sql");
  });

  await t.step("sw-селектор уходит прежней реализации", () => {
    const cases: readonly [readonly string[], boolean][] = [
      [["sw", "select 1"], true],
      [["--server", "sl-1", "workspaces"], true],
      [["42", "UPDATE t SET a = 1"], false],
      // Селектора в argv нет вовсе: мост молчит, разбор схемой сам
      // скажет, чего не хватает.
      [[], false],
    ];
    for (const [argv, expected] of cases) {
      assertEquals(sqlCommand.bridge(argv), expected, argv.join(" "));
    }
  });

  await t.step("описание тула укладывается в предел клиента", () => {
    // Описание тула клиент обрезает на 2048 байтах молча, а кириллица
    // весит по два байта на букву (`platform/mcp-server.md`).
    const bytes = new TextEncoder().encode(
      `${sqlCommand.summary}\n\n${sqlCommand.help}`,
    ).length;
    assertEquals(bytes < 2048, true, `описание не влезло: ${bytes} байт`);
  });
});
