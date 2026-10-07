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

import { beforeAll, describe, expect, it } from "vitest";
import { rejected } from "../testing/thrown.ts";
import { readFile } from "node:fs/promises";
import {
  DomainError,
  type EnvFile,
  formatCommandError,
  UsageError,
  VerbatimError,
} from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { sqlCommand } from "./cmd_sql.ts";
import type { SqlOutcome } from "./render.ts";
import { runSql, type SqlArgs, type SqlResult } from "./run.ts";
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
      // Пакетное исполнение этот тест не ожидает: объявлено, чтобы
      // случайное обращение к нему краснело, а не работало молча.
      runMany: () => Promise.reject(new Error("runMany не ожидается")),
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
  return await readFile(
    new URL(`./testdata/sql/${name}`, import.meta.url),
    "utf8",
  );
}

it("мета-блок пишущей сессии: строки mode нет", async () => {
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
  expect(stderr()).toStrictEqual(
    (await golden("dry-v-server-stderr.txt"))
      .replaceAll("<pg_host>", PG_HOST)
      .replaceAll("<N>", "3"),
  );
  // `--dry` не открывает соединений — единственный режим, безопасный по
  // построению (спека, «Инварианты»).
  expect(sessions.asked).toStrictEqual([]);
});

it("сессия пишущая: только-чтение на соединении не проверяется", async () => {
  const sessions = fakeSessions(() => DONE_ZERO);
  const { io } = harness();
  await runSql(
    args({ selector: "sl-3", sql: "UPDATE t SET a = 1 WHERE 1=0" }),
    io,
    { mode: "write", openSession: sessions.open },
  );
  // Служебного `SELECT current_setting(...)` у `mpu sql` нет: запрет
  // записи он не ставит и подтверждать ему нечего.
  expect(sessions.asked).toStrictEqual(["UPDATE t SET a = 1 WHERE 1=0"]);
});

describe("успех записи без набора строк — эталоны канала", () => {
  const sessions = fakeSessions(() => DONE_ZERO);
  const { io } = harness();
  const argv = ["sl-3", "UPDATE t SET a = 1 WHERE 1=0"];
  let result: SqlResult;
  beforeAll(async () => {
    result = await runSql(args({ selector: argv[0], sql: argv[1] }), io, {
      mode: "write",
      openSession: sessions.open,
    });
  });

  it("ok-rowcount-stdout.txt", async () => {
    expect(sqlCommand.renderResult(result, argv)).toStrictEqual(
      await golden("ok-rowcount-stdout.txt"),
    );
  });

  it("ok-rowcount-json-stdout.txt", async () => {
    expect(sqlCommand.renderResult(result, [...argv, "--json"])).toStrictEqual(
      await golden("ok-rowcount-json-stdout.txt"),
    );
  });
});

it("--dry: намерение без вывода в stdout", async () => {
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
  expect(sqlCommand.renderResult(result, argv)).toBe("");
  expect(sessions.asked).toStrictEqual([]);
});

it("ошибка БД: текст сервера как есть, без своих подсказок", async () => {
  const server =
    'syntax error at or near "SELEC"\n' + "LINE 1: SELEC 1\n" + "        ^";
  const sessions = fakeSessions(() => new DbError(server));
  const { io } = harness();
  const err = await rejected(
    () =>
      runSql(args({ selector: "sl-3", sql: "SELEC 1" }), io, {
        mode: "write",
        openSession: sessions.open,
      }),
    VerbatimError,
  );
  expect(`${formatCommandError("sql", err)}\n`).toStrictEqual(
    await golden("db-error-stderr.txt"),
  );
});

it("sw-селектор: отказ и у пишущей половины", async () => {
  // Отказ выброшенного маршрута живёт в общем `runSql`, но префикс
  // ошибки у половин разный: без этой проверки свидетелем текста была
  // бы только `sql-ro`.
  const { io } = harness();
  const err = await rejected(
    () =>
      runSql(args({ selector: "workspaces", sql: "UPDATE t SET a = 1" }), io, {
        mode: "write",
      }),
    UsageError,
  );
  expect(formatCommandError("sql", err)).toBe(
    "mpu sql: маршрут sw выброшен: доступа к контуру воркспейсов нет",
  );
});

describe("объявление команды: политика и предел описания", () => {
  it("мутирующая команда — класс rw", () => {
    expect(sqlCommand.path).toStrictEqual(["sql"]);
    expect(sqlCommand.policy).toBe("rw");
    expect(sqlCommand.errorName).toBe("sql");
  });

  it("описание тула укладывается в предел клиента", () => {
    // Описание тула клиент обрезает на 2048 байтах молча, а кириллица
    // весит по два байта на букву (`platform/mcp-server.md`).
    const bytes = new TextEncoder().encode(
      `${sqlCommand.summary}\n\n${sqlCommand.help}`,
    ).length;
    expect(bytes < 2048, `описание не влезло: ${bytes} байт`).toBe(true);
  });
});
