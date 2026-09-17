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

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { UsageError } from "../command/mod.ts";
import { makeEnvFile } from "../env/mod.ts";
import type { SqlOutcome } from "../sql/render.ts";
import type { SqlSession } from "../sql/session.ts";
import type { PgTarget } from "../sql/target.ts";
import { makeFakeIo } from "../testing/mod.ts";
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
  return await Deno.readTextFile(
    new URL("./testdata/clean-local-clients/dry-run.stdout", import.meta.url),
  );
}

/** Схемы стенда на момент снятия голдена. */
const SCHEMAS = ["schema_54", "shared", "schema_1498"];

Deno.test("сухой прогон: отчёт — эталон канала, ни одной записи", async () => {
  const sent: Sent[] = [];
  const result = await runCleanLocal(
    { keep: undefined, yes: false },
    ioWith(),
    {
      openSession: fakeSessions([["pg_namespace", rows(SCHEMAS)]], sent),
    },
  );

  assertEquals(renderCleanLocal(result), await golden());
  // Read-only без `--yes`: единственный запрос — чтение списка схем.
  assertEquals(sent.length, 1);
  assertEquals(sent[0].kind, "query");
  assertStringIncludes(sent[0].sql, "pg_namespace");
  assertEquals(sent[0].port, 5441);
});

Deno.test("keep-лист инверсный; схема shared не попадает в цели", async (t) => {
  const run = async (keep: string | undefined) => {
    const sent: Sent[] = [];
    const result = await runCleanLocal({ keep, yes: false }, ioWith(), {
      openSession: fakeSessions([["pg_namespace", rows(SCHEMAS)]], sent),
    });
    return result;
  };

  await t.step("по умолчанию оставляются 54 и 776", async () => {
    const result = await run(undefined);
    assertEquals(result.clients, [54, 1498]);
    assertEquals(result.keep, [54, 776]);
    assertEquals(result.targets, [1498]);
  });

  await t.step("shared в целях не бывает: у неё нет номера", async () => {
    const result = await run("");
    // Пустой keep-лист — валидный вызов «снести всё локальное», и даже
    // тогда `shared` в целях нет: цели строятся из схем `schema_<N>`.
    assertEquals(result.keep, []);
    assertEquals(result.targets, [54, 1498]);
  });

  await t.step("пробелы вокруг токенов допустимы", () => {
    assertEquals(parseKeep(" 54 , 776 , "), [54, 776]);
  });

  await t.step("нечисловой токен — ошибка ввода", async () => {
    const sent: Sent[] = [];
    await assertRejects(
      () =>
        runCleanLocal({ keep: "54,abc", yes: false }, ioWith(), {
          openSession: fakeSessions([], sent),
        }),
      UsageError,
      "keep: 'abc' не число (ожидается список client_id)",
    );
    // Разбор до подключения: неверный вызов не стоит ни одного соединения.
    assertEquals(sent, []);
  });
});

Deno.test("нечего удалять — ранний выход без sl-0 и воркспейсов", async () => {
  const sent: Sent[] = [];
  const result = await runCleanLocal({ keep: "54,1498", yes: true }, ioWith(), {
    openSession: fakeSessions([["pg_namespace", rows(SCHEMAS)]], sent),
  });
  assertEquals(result.targets, []);
  assertStringIncludes(
    renderCleanLocal(result),
    "✓ нечего удалять — все локальные клиенты в keep-листе",
  );
  // Даже с `--yes`: соединений к sl-0 и воркспейсам не открывалось.
  assertEquals(sent.map((item) => item.port), [5441]);
});

Deno.test("нет схем вовсе — прочерк и успех", async () => {
  const sent: Sent[] = [];
  const result = await runCleanLocal(
    { keep: undefined, yes: false },
    ioWith(),
    {
      openSession: fakeSessions([["pg_namespace", rows([])]], sent),
    },
  );
  assertStringIncludes(renderCleanLocal(result), "локальные клиенты sl-1: —\n");
});

Deno.test("SQL очистки: наборы таблиц и порядок операций", async (t) => {
  await t.step("sl-1: дети spreadsheets, клиенты, схемы", () => {
    const sql = sl1Sql([1498]);
    const lines = sql.split("\n");
    assertEquals(lines[0], "SET session_replication_role = replica;");
    // Дети удаляются по множеству spreadsheet_id клиента.
    assertStringIncludes(
      sql,
      "DELETE FROM public.spreadsheets_sheets WHERE spreadsheet_id IN " +
        "(SELECT spreadsheet_id FROM public.spreadsheets WHERE client_id IN (1498));",
    );
    assertStringIncludes(sql, "DELETE FROM public.clients WHERE id IN (1498);");
    assertStringIncludes(
      sql,
      "DELETE FROM public.wb_loader_nm_ids_data WHERE client_id IN (1498);",
    );
    // DROP SCHEMA — последним: сначала public-строки, потом сама схема.
    assertEquals(
      lines[lines.length - 1],
      "DROP SCHEMA IF EXISTS schema_1498 CASCADE;",
    );
  });

  await t.step("sl-0: только клиенты и токены", () => {
    const sql = sl0Sql([1498]);
    assertStringIncludes(sql, "DELETE FROM public.clients WHERE id IN (1498);");
    assertStringIncludes(
      sql,
      "DELETE FROM public.wb_tokens WHERE client_id IN (1498);",
    );
    // Схем на sl-0 нет — и DROP SCHEMA там взяться неоткуда.
    assertEquals(sql.includes("DROP SCHEMA"), false);
  });

  await t.step("несколько целей идут одним списком", () => {
    assertStringIncludes(sl1Sql([2, 3]), "WHERE id IN (2, 3);");
    assertStringIncludes(
      sl1Sql([2, 3]),
      "DROP SCHEMA IF EXISTS schema_2 CASCADE;",
    );
    assertStringIncludes(
      sl1Sql([2, 3]),
      "DROP SCHEMA IF EXISTS schema_3 CASCADE;",
    );
  });
});

Deno.test("удаление: три подключения по порядку и счётчики", async () => {
  const sent: Sent[] = [];
  const result = await runCleanLocal({ keep: "54", yes: true }, ioWith(), {
    openSession: fakeSessions([
      ["pg_namespace", rows(SCHEMAS)],
      ["FROM public.users WHERE email", rows(["u-1498"])],
      ["FROM public.workspaces WHERE id", rows([1498])],
    ], sent),
  });

  assertEquals(result.targets, [1498]);
  assertEquals([result.deleted, result.workspaces], [1, 1]);
  // Порядок портов: sl-1 (5441) → sl-0 (5440) → воркспейсы (5451).
  assertEquals([...new Set(sent.map((item) => item.port))], [5441, 5440, 5451]);
  assertStringIncludes(
    renderCleanLocal(result),
    "удалено клиентов: 1; снято workspace-проводок: 1\n",
  );
  const workspaceSql = sent.filter((item) => item.port === 5451).map((i) =>
    i.sql
  );
  // Порядок удаления явный и FK-безопасный: подписки → связки →
  // кабинеты → сам workspace, и только потом user.
  const removal = workspaceSql.find((sql) => sql.includes("subscriptions"))!;
  assertEquals(
    removal.split("\n").map((line) => line.split(" ")[2]),
    [
      "public.subscriptions",
      "public.workspaces_wb_cabinets",
      "public.wb_cabinets",
      "public.workspaces",
    ],
  );
});

Deno.test("вход под чужим email не снимается — closed preserve", async () => {
  const sent: Sent[] = [];
  const result = await runCleanLocal({ keep: "54", yes: true }, ioWith(), {
    openSession: fakeSessions([
      ["pg_namespace", rows(SCHEMAS)],
      // Пользователя с сигнатурой `client_1498@local.host` нет: вход
      // заводили вручную под другим адресом.
      ["FROM public.users WHERE email", rows([])],
    ], sent),
  });

  assertEquals(result.workspaces, 0);
  const workspaceSql = sent.filter((item) => item.port === 5451);
  // Единственный запрос к БД воркспейсов — поиск по сигнатуре; ни
  // одного удаления. Команда убирает то, что завела сама, а снос чужой
  // учётной записи из-за совпадения номера был бы хуже остатка.
  assertEquals(workspaceSql.length, 1);
  assertEquals(workspaceSql[0].kind, "query");
  assertEquals(workspaceSql[0].sql.includes("DELETE"), false);
});

Deno.test("подключения всегда локальные, порты — из env-файла", async (t) => {
  await t.step("хост зашит: прод недостижим", () => {
    const io = ioWith({ PG_LOCAL_PORT: "6000" });
    assertEquals(sl1Target(io).host, "127.0.0.1");
    assertEquals(sl0Target(io).host, "127.0.0.1");
    assertEquals(workspacesTarget(io).host, "127.0.0.1");
    assertEquals(sl1Target(io).port, 6000);
  });

  await t.step("умолчания портов — из спеки", () => {
    const io = ioWith();
    assertEquals(sl1Target(io).port, 5441);
    assertEquals(sl0Target(io).port, 5440);
    assertEquals(workspacesTarget(io).port, 5451);
  });

  await t.step("нет пароля — ошибка ввода настоящего слоя", async () => {
    // Слой env-файла бросает доменную ошибку, а спека требует кода 2:
    // фейк, бросающий сразу UsageError, прошёл бы и на сломанном коде,
    // поэтому здесь настоящий `makeEnvFile` без единого ключа.
    const io = makeFakeIo({ envFile: makeEnvFile(undefined) });
    const err = await assertRejects(
      () =>
        runCleanLocal({ keep: undefined, yes: false }, io, {
          openSession: fakeSessions([], []),
        }),
      UsageError,
      "environment variable PG_PASSWORD is not set",
    );
    assertEquals(err instanceof UsageError, true);
  });

  await t.step("PG_MAIN_USER_PASSWORD годится вместо PG_PASSWORD", () => {
    const io = makeFakeIo({
      envFile: makeEnvFile({
        path: "/nowhere/.env",
        readSync: () => "PG_MAIN_USER_PASSWORD=главный\n",
        write: () => Promise.reject(new Error("не ожидается")),
      }),
    });
    assertEquals(sl1Target(io).password, "главный");
  });

  await t.step("мусор в порту — ошибка ввода, а не умолчание", () => {
    const io = ioWith({ PG_LOCAL_PORT: "54a1" });
    // Молча взять 5441 значило бы почистить не тот локальный PG.
    assertThrows(
      () => sl1Target(io),
      UsageError,
      'PG_LOCAL_PORT ожидает порт 1–65535, получено "54a1"',
    );
  });
});

Deno.test("без --yes соединение открывается только на чтение", async () => {
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
  assertEquals(modes, ["5441"]);
});
