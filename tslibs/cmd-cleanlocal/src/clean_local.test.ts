/**
 * Команда `mpu clean-local-clients`
 * (`docs/specs/clean-local-clients.md`): сухой прогон против эталона
 * канала, keep-лист, тексты SQL и то, чего команда НЕ трогает.
 *
 * Живого PostgreSQL здесь нет и не будет: реальную очистку не гоняют
 * ни в этой сессии, ни на паре — на локальном стенде живут данные,
 * нужные другим проверкам. Поэтому SQL сверяется как текст, а сессия
 * подменяется записывающей всё, что ей отправили.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { rejected, thrown } from "@mpu/testing/thrown";
import { UsageError } from "@mpu/command";
import { makeEnvFile } from "@mpu/command/env";
import type { PgTarget, SqlOutcome, SqlSession } from "@mpu/cmd-sql";
import { makeFakeIo } from "@mpu/command/testing";
import {
  type CleanIo,
  renderCleanLocal,
  runCleanLocal,
  sl0Target,
  sl1Target,
  workspacesTarget,
} from "./cmd_clean_local.ts";
import { parseKeep, sl0Sql, sl1Sql } from "./plan.ts";

/** Что стенд «увидел»: цель подключения и отправленный текст. */
interface Sent {
  readonly port: number;
  readonly kind: "query" | "run";
  readonly sql: string;
}

/** Ответы стенда: SQL-подстрока → результат. */
type Replies = readonly (readonly [string, SqlOutcome])[];

const rows = (values: readonly (string | number)[]): SqlOutcome => ({
  kind: "rows",
  columns: ["value"],
  rows: values.map((value) => [value]),
});

const done: SqlOutcome = { kind: "done", rowcount: 0 };

/** io с полным набором ключей подключений. */
function ioWith(env: Record<string, string> = {}): CleanIo {
  const values: Record<string, string> = { PG_PASSWORD: "проба", ...env };
  return makeFakeIo({
    envFile: {
      get: (name: string) => values[name],
      require: (name: string) => {
        const value = values[name];
        if (value === undefined) throw new UsageError(`нет ключа ${name}`);
        return value;
      },
      set: () => Promise.reject(new Error("запись env-файла не ожидается")),
      values: () => ({ ...values }),
    },
  });
}

/** Подставная сессия: копит отправленное, отвечает по подстроке. */
function fakeSessions(replies: Replies, sent: Sent[]) {
  return (target: PgTarget): Promise<SqlSession> => {
    const answer = (kind: "query" | "run", sql: string): SqlOutcome => {
      sent.push({ port: target.port, kind, sql });
      for (const [needle, outcome] of replies) {
        if (sql.includes(needle)) return outcome;
      }
      return done;
    };
    return Promise.resolve({
      query: (sql: string) => Promise.resolve(answer("query", sql)),
      run: (sql: string) => Promise.resolve(answer("run", sql)),
      // Пакетное исполнение этот тест не ожидает: объявлено, чтобы
      // случайное обращение к нему краснело, а не работало молча.
      runMany: () => Promise.reject(new Error("runMany не ожидается")),
      close: () => Promise.resolve(),
    });
  };
}

async function golden(): Promise<string> {
  return await readFile(
    new URL("./testdata/clean-local-clients/dry-run.stdout", import.meta.url),
    "utf8",
  );
}

/** Схемы стенда на момент снятия голдена. */
const SCHEMAS = ["schema_54", "shared", "schema_1498"];

it("сухой прогон: отчёт — эталон канала, ни одной записи", async () => {
  const sent: Sent[] = [];
  const result = await runCleanLocal(
    { keep: undefined, yes: false },
    ioWith(),
    {
      openSession: fakeSessions([["pg_namespace", rows(SCHEMAS)]], sent),
    },
  );

  expect(renderCleanLocal(result)).toStrictEqual(await golden());
  // Read-only без `--yes`: единственный запрос — чтение списка схем.
  expect(sent.length).toBe(1);
  expect(sent[0].kind).toBe("query");
  expect(sent[0].sql).toContain("pg_namespace");
  expect(sent[0].port).toBe(5441);
});

describe("keep-лист инверсный; схема shared не попадает в цели", () => {
  const run = async (keep: string | undefined) => {
    const sent: Sent[] = [];
    const result = await runCleanLocal({ keep, yes: false }, ioWith(), {
      openSession: fakeSessions([["pg_namespace", rows(SCHEMAS)]], sent),
    });
    return result;
  };

  it("по умолчанию оставляются 54 и 776", async () => {
    const result = await run(undefined);
    expect(result.clients).toStrictEqual([54, 1498]);
    expect(result.keep).toStrictEqual([54, 776]);
    expect(result.targets).toStrictEqual([1498]);
  });

  it("shared в целях не бывает: у неё нет номера", async () => {
    const result = await run("");
    // Пустой keep-лист — валидный вызов «снести всё локальное», и даже
    // тогда `shared` в целях нет: цели строятся из схем `schema_<N>`.
    expect(result.keep).toStrictEqual([]);
    expect(result.targets).toStrictEqual([54, 1498]);
  });

  it("пробелы вокруг токенов допустимы", () => {
    expect(parseKeep(" 54 , 776 , ")).toStrictEqual([54, 776]);
  });

  it("нечисловой токен — ошибка ввода", async () => {
    const sent: Sent[] = [];
    await rejected(
      () =>
        runCleanLocal({ keep: "54,abc", yes: false }, ioWith(), {
          openSession: fakeSessions([], sent),
        }),
      UsageError,
      "keep: 'abc' не число (ожидается список client_id)",
    );
    // Разбор до подключения: неверный вызов не стоит ни одного соединения.
    expect(sent).toStrictEqual([]);
  });
});

it("нечего удалять — ранний выход без sl-0 и воркспейсов", async () => {
  const sent: Sent[] = [];
  const result = await runCleanLocal({ keep: "54,1498", yes: true }, ioWith(), {
    openSession: fakeSessions([["pg_namespace", rows(SCHEMAS)]], sent),
  });
  expect(result.targets).toStrictEqual([]);
  expect(renderCleanLocal(result)).toContain(
    "✓ нечего удалять — все локальные клиенты в keep-листе",
  );
  // Даже с `--yes`: соединений к sl-0 и воркспейсам не открывалось.
  expect(sent.map((item) => item.port)).toStrictEqual([5441]);
});

it("нет схем вовсе — прочерк и успех", async () => {
  const sent: Sent[] = [];
  const result = await runCleanLocal(
    { keep: undefined, yes: false },
    ioWith(),
    {
      openSession: fakeSessions([["pg_namespace", rows([])]], sent),
    },
  );
  expect(renderCleanLocal(result)).toContain("локальные клиенты sl-1: —\n");
});

describe("SQL очистки: наборы таблиц и порядок операций", () => {
  it("sl-1: дети spreadsheets, клиенты, схемы", () => {
    const sql = sl1Sql([1498]);
    const lines = sql.split("\n");
    expect(lines[0]).toBe("SET session_replication_role = replica;");
    // Дети удаляются по множеству spreadsheet_id клиента.
    expect(sql).toContain(
      "DELETE FROM public.spreadsheets_sheets WHERE spreadsheet_id IN " +
        "(SELECT spreadsheet_id FROM public.spreadsheets WHERE client_id IN (1498));",
    );
    expect(sql).toContain("DELETE FROM public.clients WHERE id IN (1498);");
    expect(sql).toContain(
      "DELETE FROM public.wb_loader_nm_ids_data WHERE client_id IN (1498);",
    );
    // DROP SCHEMA — последним: сначала public-строки, потом сама схема.
    expect(lines[lines.length - 1]).toBe(
      "DROP SCHEMA IF EXISTS schema_1498 CASCADE;",
    );
  });

  it("sl-0: только клиенты и токены", () => {
    const sql = sl0Sql([1498]);
    expect(sql).toContain("DELETE FROM public.clients WHERE id IN (1498);");
    expect(sql).toContain(
      "DELETE FROM public.wb_tokens WHERE client_id IN (1498);",
    );
    // Схем на sl-0 нет — и DROP SCHEMA там взяться неоткуда.
    expect(sql.includes("DROP SCHEMA")).toBe(false);
  });

  it("несколько целей идут одним списком", () => {
    expect(sl1Sql([2, 3])).toContain("WHERE id IN (2, 3);");
    expect(sl1Sql([2, 3])).toContain("DROP SCHEMA IF EXISTS schema_2 CASCADE;");
    expect(sl1Sql([2, 3])).toContain("DROP SCHEMA IF EXISTS schema_3 CASCADE;");
  });
});

it("удаление: три подключения по порядку и счётчики", async () => {
  const sent: Sent[] = [];
  const result = await runCleanLocal({ keep: "54", yes: true }, ioWith(), {
    openSession: fakeSessions(
      [
        ["pg_namespace", rows(SCHEMAS)],
        ["FROM public.users WHERE email", rows(["u-1498"])],
        ["FROM public.workspaces WHERE id", rows([1498])],
      ],
      sent,
    ),
  });

  expect(result.targets).toStrictEqual([1498]);
  expect([result.deleted, result.workspaces]).toStrictEqual([1, 1]);
  // Порядок портов: sl-1 (5441) → sl-0 (5440) → воркспейсы (5451).
  expect([...new Set(sent.map((item) => item.port))]).toStrictEqual([
    5441, 5440, 5451,
  ]);
  expect(renderCleanLocal(result)).toContain(
    "удалено клиентов: 1; снято workspace-проводок: 1\n",
  );
  const workspaceSql = sent
    .filter((item) => item.port === 5451)
    .map((i) => i.sql);
  // Порядок удаления явный и FK-безопасный: подписки → связки →
  // кабинеты → сам workspace, и только потом user.
  const removal = workspaceSql.find((sql) => sql.includes("subscriptions"))!;
  expect(removal.split("\n").map((line) => line.split(" ")[2])).toStrictEqual([
    "public.subscriptions",
    "public.workspaces_wb_cabinets",
    "public.wb_cabinets",
    "public.workspaces",
  ]);
});

it("вход под чужим email не снимается — closed preserve", async () => {
  const sent: Sent[] = [];
  const result = await runCleanLocal({ keep: "54", yes: true }, ioWith(), {
    openSession: fakeSessions(
      [
        ["pg_namespace", rows(SCHEMAS)],
        // Пользователя с сигнатурой `client_1498@local.host` нет: вход
        // заводили вручную под другим адресом.
        ["FROM public.users WHERE email", rows([])],
      ],
      sent,
    ),
  });

  expect(result.workspaces).toBe(0);
  const workspaceSql = sent.filter((item) => item.port === 5451);
  // Единственный запрос к БД воркспейсов — поиск по сигнатуре; ни
  // одного удаления. Команда убирает то, что завела сама, а снос чужой
  // учётной записи из-за совпадения номера был бы хуже остатка.
  expect(workspaceSql.length).toBe(1);
  expect(workspaceSql[0].kind).toBe("query");
  expect(workspaceSql[0].sql.includes("DELETE")).toBe(false);
});

describe("подключения всегда локальные, порты — из env-файла", () => {
  it("хост зашит: прод недостижим", () => {
    const io = ioWith({ PG_LOCAL_PORT: "6000" });
    expect(sl1Target(io).host).toBe("127.0.0.1");
    expect(sl0Target(io).host).toBe("127.0.0.1");
    expect(workspacesTarget(io).host).toBe("127.0.0.1");
    expect(sl1Target(io).port).toBe(6000);
  });

  it("умолчания портов — из спеки", () => {
    const io = ioWith();
    expect(sl1Target(io).port).toBe(5441);
    expect(sl0Target(io).port).toBe(5440);
    expect(workspacesTarget(io).port).toBe(5451);
  });

  it("нет пароля — ошибка ввода настоящего слоя", async () => {
    // Слой env-файла бросает доменную ошибку, а спека требует кода 2:
    // фейк, бросающий сразу UsageError, прошёл бы и на сломанном коде,
    // поэтому здесь настоящий `makeEnvFile` без единого ключа.
    const io = makeFakeIo({ envFile: makeEnvFile(undefined) });
    const err = await rejected(
      () =>
        runCleanLocal({ keep: undefined, yes: false }, io, {
          openSession: fakeSessions([], []),
        }),
      UsageError,
      "environment variable PG_PASSWORD is not set",
    );
    expect(err instanceof UsageError).toBe(true);
  });

  it("PG_MAIN_USER_PASSWORD годится вместо PG_PASSWORD", () => {
    const io = makeFakeIo({
      envFile: makeEnvFile({
        path: "/nowhere/.env",
        readSync: () => "PG_MAIN_USER_PASSWORD=главный\n",
        write: () => Promise.reject(new Error("не ожидается")),
      }),
    });
    expect(sl1Target(io).password).toBe("главный");
  });

  it("мусор в порту — ошибка ввода, а не умолчание", () => {
    const io = ioWith({ PG_LOCAL_PORT: "54a1" });
    // Молча взять 5441 значило бы почистить не тот локальный PG.
    thrown(
      () => sl1Target(io),
      UsageError,
      'PG_LOCAL_PORT ожидает порт 1–65535, получено "54a1"',
    );
  });
});

it("без --yes соединение открывается только на чтение", async () => {
  const modes: string[] = [];
  await runCleanLocal({ keep: undefined, yes: false }, ioWith(), {
    openSession: (target) => {
      modes.push(String(target.port));
      return Promise.resolve({
        query: () =>
          Promise.resolve(rows(["schema_54", "schema_1498"]) as SqlOutcome),
        run: () => Promise.reject(new Error("запись без --yes не ожидается")),
        // Пакетное исполнение этот тест не ожидает: объявлено, чтобы
        // случайное обращение к нему краснело, а не работало молча.
        runMany: () => Promise.reject(new Error("runMany не ожидается")),
        close: () => Promise.resolve(),
      });
    },
  });
  expect(modes).toStrictEqual(["5441"]);
});
