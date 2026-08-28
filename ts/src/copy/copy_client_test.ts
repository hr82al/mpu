/**
 * Команда `mpu copy-client` (`docs/specs/copy-client.md`): порядок
 * шагов, направление записи, счётчики строк и тексты отказов.
 *
 * Ни живого PostgreSQL, ни `pg_dump` здесь нет: инструмент и сессии
 * подменены записывающими функциями. Голденов у семейства нет
 * намеренно — вывод `copy-client` это почти тысяча строк живого лога
 * `pg_restore`, привязанного к версиям и данным, — поэтому проверяется
 * структура: что запустили, в каком порядке и куда писали.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { DomainError, UsageError } from "../command/mod.ts";
import type { SqlOutcome } from "../sql/render.ts";
import {
  type SqlSession,
  type Statement,
  StatementError,
} from "../sql/session.ts";
import type { PgTarget } from "../sql/target.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import {
  type CopyIo,
  renderCopyClient,
  runCopyClient,
} from "./cmd_copy_client.ts";
import { LOCAL_CONTAINERS } from "./targets.ts";

const CLIENT = 5175;

/** Что «увидел» подставной PostgreSQL. */
interface Sent {
  readonly port: number;
  /** `many` — весь посев одним вызовом: список операторов транзакции. */
  readonly kind: "query" | "run" | "many";
  readonly sql: string;
  readonly mode: "read-only" | "write";
  /** Значения-параметры: у посева они отдельно от текста. */
  readonly params?: readonly unknown[];
}

/** Что запустили как внешний инструмент. */
interface Tool {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

const rows = (
  columns: readonly string[],
  values: readonly (readonly unknown[])[],
): SqlOutcome => ({ kind: "rows", columns, rows: values as never });

const done: SqlOutcome = { kind: "done", rowcount: 0 };

/**
 * Пароли разведены нарочно: у источника цепочка
 * `PG_MY_USER_PASSWORD → PG_MAIN_USER_PASSWORD`, у локальных
 * приёмников — `PG_MAIN_USER_PASSWORD → PG_PASSWORD` (`copy-client.md`,
 * «Конфигурация»). Задав оба конца, тест видит, что в каждый инструмент
 * ушёл свой.
 */
const ENV: Record<string, string> = {
  pg_1: "pg-prod-1.example.test",
  PG_MAIN_USER_NAME: "wb_plus_db_admin",
  PG_MY_USER_PASSWORD: "прод-пароль",
  PG_MAIN_USER_PASSWORD: "локальный-пароль",
};

/** io с кэшем, где лежит клиент 5175 на сервере sl-1. */
async function withIo(
  body: (io: CopyIo, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    db.execute(
      "INSERT INTO sl_clients (client_id, server, is_active, is_locked, " +
        "is_deleted, synced_at) VALUES (?, 'sl-1', 1, 0, 0, 0)",
      CLIENT,
    );
    const io = makeFakeIo({
      openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }),
      progress: () => {},
      envFile: {
        get: (name: string) => ENV[name],
        require: (name: string) => {
          const value = ENV[name];
          if (value === undefined) throw new UsageError(`нет ключа ${name}`);
          return value;
        },
        set: () => Promise.reject(new Error("не ожидается")),
        values: () => ({ ...ENV }),
      },
    });
    await body(io, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Подставные сессии: копят SQL, отвечают строкой клиента. */
function sessions(sent: Sent[], replies: Map<string, SqlOutcome> = new Map()) {
  return (
    target: PgTarget,
    mode: "read-only" | "write",
  ): Promise<SqlSession> => {
    const answer = (kind: "query" | "run", sql: string): SqlOutcome => {
      sent.push({ port: target.port, kind, sql, mode });
      for (const [needle, outcome] of replies) {
        if (sql.includes(needle)) return outcome;
      }
      if (sql.startsWith("SELECT * FROM public.clients")) {
        return rows(["id", "server"], [[CLIENT, "sl-3"]]);
      }
      if (sql.startsWith("SELECT spreadsheet_id")) {
        // Идентификатор таблицы — строка, а не число: у Google это
        // `1BxiMVs0XRA5…`, и подставной ответ обязан быть таким же.
        return rows(["spreadsheet_id"], [["1BxiMVs0XRA5"], ["ss-второй"]]);
      }
      if (sql.startsWith("SELECT *")) return rows(["client_id"], [[CLIENT]]);
      return done;
    };
    return Promise.resolve({
      query: (sql: string) => Promise.resolve(answer("query", sql)),
      run: (sql: string) => Promise.resolve(answer("run", sql)),
      // Посев идёт списком операторов со значениями-параметрами; для
      // проверок он ничем не отличается от прежнего текста, кроме того,
      // что каждый оператор виден отдельно.
      runMany: (statements: readonly Statement[]) => {
        // Весь посев — один вызов и одна транзакция; текст операторов
        // склеивается только для проверок, серверу каждый уходит своим
        // вызовом со своими значениями.
        sent.push({
          port: target.port,
          kind: "many",
          mode,
          sql: statements.map((statement) => statement.sql).join(";\n"),
          params: statements.flatMap((statement) => statement.params ?? []),
        });
        return Promise.resolve(
          statements.map(() => done),
        );
      },
      close: () => Promise.resolve(),
    });
  };
}

/** Инструмент, отвечающий заданными кодами по порядку вызовов. */
function tools(codes: readonly number[], seen: Tool[], lines: string[] = []) {
  let call = 0;
  return (
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
    onLine: (line: string) => void,
  ) => {
    seen.push({ argv: [...argv], env: { ...env } });
    for (const line of lines) onLine(line);
    return Promise.resolve({ code: codes[call++] ?? 0 });
  };
}

Deno.test("порядок шага схемы: дамп раньше сноса цели", async () => {
  await withIo(async (io) => {
    const seen: Tool[] = [];
    const sent: Sent[] = [];
    const removed: string[] = [];
    await runCopyClient({ selector: String(CLIENT) }, io, {
      runTool: tools([0, 0], seen),
      openSession: sessions(sent),
      tempFile: () => "/tmp/проба.dump",
      removeFile: (path) => void removed.push(path),
      nowMs: () => 0,
    });

    assertEquals(seen.map((tool) => tool.argv[0]), ["pg_dump", "pg_restore"]);
    // Снос цели стоит между дампом и восстановлением: до дампа он
    // необратимо снёс бы прежнюю копию, после восстановления — только
    // что восстановленную.
    const drop = sent.findIndex((item) => item.sql.includes("DROP SCHEMA"));
    assertEquals(drop >= 0, true, "снос цели не выполнялся вовсе");
    assertEquals(sent[drop].port, 5441);
    assertEquals(
      sent[drop].sql,
      "DROP SCHEMA IF EXISTS schema_5175 CASCADE;",
    );
    // …и он раньше первого пишущего запроса со строками клиента.
    const firstRows = sent.findIndex((item) =>
      item.sql.includes("DELETE FROM")
    );
    assertEquals(drop < firstRows, true);
    // Дамп идёт с прод-инстанса, восстановление — в локальный sl-1.
    assertEquals(seen[0].argv.includes("pg-prod-1.example.test"), true);
    assertEquals(seen[1].argv.includes("127.0.0.1"), true);
    // Временный файл убран.
    assertEquals(removed, ["/tmp/проба.dump"]);
  });
});

Deno.test("упавший дамп не сносит цель и не восстанавливает", async () => {
  await withIo(async (io) => {
    const seen: Tool[] = [];
    const sent: Sent[] = [];
    const err = await assertRejects(
      () =>
        runCopyClient({ selector: String(CLIENT) }, io, {
          runTool: tools([1], seen, ["pg_dump: error: connection failed"]),
          openSession: sessions(sent),
          tempFile: () => "/tmp/проба.dump",
          removeFile: () => {},
          nowMs: () => 0,
        }),
      DomainError,
    );
    // `DROP SCHEMA … CASCADE` необратим: упавший дамп не должен стоить
    // оператору прежней копии.
    assertEquals(seen.map((tool) => tool.argv[0]), ["pg_dump"]);
    assertEquals(sent.some((item) => item.sql.includes("DROP SCHEMA")), false);
    assertStringIncludes(err.message, "pg_dump schema_5175 failed (exit 1");
  });
});

Deno.test("ненулевой pg_restore — отказ с последней ошибкой инструмента", async () => {
  await withIo(async (io) => {
    const seen: Tool[] = [];
    const err = await assertRejects(
      () =>
        runCopyClient({ selector: String(CLIENT) }, io, {
          // Ровно тот случай, ради которого спека завела раздел про
          // ловушки: схема восстановлена целиком, а код ненулевой.
          runTool: tools([0, 1], seen, [
            "pg_restore: creating TABLE schema_5175.orders",
            "pg_restore: error: could not execute query: ERROR:  " +
            'unrecognized configuration parameter "transaction_timeout"',
            "pg_restore: warning: errors ignored on restore: 1",
          ]),
          openSession: sessions([]),
          tempFile: () => "/tmp/проба.dump",
          removeFile: () => {},
          nowMs: () => 0,
        }),
      DomainError,
    );
    assertStringIncludes(err.message, "pg_restore schema_5175 failed (exit 1");
    // Без последней ошибки оператор видит «failed» и не знает, что
    // 162 таблицы на месте.
    assertStringIncludes(err.message, "errors ignored on restore: 1");
  });
});

Deno.test("запись идёт только в локальные приёмники", async () => {
  await withIo(async (io) => {
    const sent: Sent[] = [];
    await runCopyClient({ selector: String(CLIENT) }, io, {
      runTool: tools([0, 0], []),
      openSession: sessions(sent),
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
    });
    // Пишущие вызовы теперь двух видов: посев уходит списком
    // (`many`), проводка входа — одним текстом (`run`).
    const writes = sent.filter((item) => item.kind !== "query");
    // Прод (5432) не получает ни одного пишущего запроса: все DELETE,
    // INSERT и проводка входа уходят на локальные приёмники.
    assertEquals(
      [...new Set(writes.map((item) => item.port))],
      [5441, 5440, 5451],
    );
    const reads = sent.filter((item) => item.port === 5432);
    assertEquals(reads.every((item) => item.kind === "query"), true);
    assertEquals(reads.every((item) => item.sql.startsWith("SELECT")), true);
  });
});

Deno.test("счётчики строк печатаются по каждой таблице", async () => {
  await withIo(async (io) => {
    const lines: string[] = [];
    const loud = { ...io, progress: (line: string) => void lines.push(line) };
    const result = await runCopyClient({ selector: String(CLIENT) }, loud, {
      runTool: tools([0, 0], []),
      openSession: sessions([]),
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
    });

    assertEquals(result.clientId, CLIENT);
    assertEquals(result.schema, "schema_5175");
    // По счётчикам оператор видит, что именно скопировалось: «готово»
    // без чисел не отличить от пустой копии.
    assertStringIncludes(lines.join("\n"), "  sl-1 clients: 1");
    assertStringIncludes(lines.join("\n"), "  sl-1 spreadsheets: 1");
    assertStringIncludes(lines.join("\n"), "  sl-0 wb_tokens: 1");
    assertEquals(
      result.sl1.some((count) => count.table === "spreadsheets_sheets"),
      true,
    );
    // Дети таблиц переносятся по множеству spreadsheet_id клиента.
    assertEquals(
      result.sl0.some((count) => count.table === "spreadsheets"),
      false,
    );
  });
});

Deno.test("неподнятый локальный контейнер назван в отказе", async () => {
  await withIo(async (io) => {
    const err = await assertRejects(
      () =>
        runCopyClient({ selector: String(CLIENT) }, io, {
          runTool: tools([0, 0], []),
          openSession: (target, mode) =>
            target.host === "127.0.0.1"
              ? Promise.reject(new Error("connection refused"))
              : sessions([])(target, mode),
          tempFile: () => "/tmp/проба.dump",
          removeFile: () => {},
          nowMs: () => 0,
        }),
      UsageError,
    );
    // Сырой `connection refused` оставлял бы гадать, какой из трёх
    // контейнеров стенда не поднят.
    assertStringIncludes(err.message, LOCAL_CONTAINERS[5441]);
    assertStringIncludes(err.message, "127.0.0.1:5441");
    assertStringIncludes(String(err.hint), "mpu mp-init");
  });
});

Deno.test("пароли уходят окружением, а не в argv", async () => {
  await withIo(async (io) => {
    const seen: Tool[] = [];
    await runCopyClient({ selector: String(CLIENT) }, io, {
      runTool: tools([0, 0], seen),
      openSession: sessions([]),
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
    });
    for (const tool of seen) {
      // argv виден в `ps` любому пользователю машины, и печатается он
      // же — перед запуском.
      assertEquals(tool.argv.includes("прод-пароль"), false);
      assertEquals(tool.argv.includes("локальный-пароль"), false);
    }
    assertEquals(seen[0].env.PGPASSWORD, "прод-пароль");
    assertEquals(seen[1].env.PGPASSWORD, "локальный-пароль");
  });
});

Deno.test("селектор без единственного client_id — ошибка ввода", async () => {
  await withIo(async (io) => {
    await assertRejects(
      () =>
        runCopyClient({ selector: "sl-1" }, io, {
          runTool: tools([0, 0], []),
          openSession: sessions([]),
          tempFile: () => "/tmp/проба.dump",
          removeFile: () => {},
          nowMs: () => 0,
        }),
      UsageError,
    );
  });
});

Deno.test("источник открывается только на чтение", async () => {
  await withIo(async (io) => {
    const sent: Sent[] = [];
    await runCopyClient({ selector: String(CLIENT) }, io, {
      runTool: tools([0, 0], []),
      openSession: sessions(sent),
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
    });
    // Инвариант «источник не мутируется» держит сервер
    // (`default_transaction_read_only`), а не аккуратность вызовов:
    // одна строчка через `run` вместо `query` иначе означала бы запись
    // в прод.
    const modes = new Map<number, Set<string>>();
    for (const item of sent) {
      modes.set(
        item.port,
        (modes.get(item.port) ?? new Set()).add(item.mode),
      );
    }
    assertEquals([...(modes.get(5432) ?? [])], ["read-only"]);
    // У локальных приёмников режим записи; sl-1 читается ещё и для
    // кабинетов проводки, поэтому у него оба.
    assertEquals([...(modes.get(5440) ?? [])].includes("write"), true);
    assertEquals([...(modes.get(5451) ?? [])], ["write"]);
  });
});

Deno.test("посев уходит одной транзакцией на приёмник", async () => {
  await withIo(async (io) => {
    const sent: Sent[] = [];
    await runCopyClient({ selector: String(CLIENT) }, io, {
      runTool: tools([0, 0], []),
      openSession: sessions(sent),
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
    });
    // Каждый `run` — своя транзакция: разбив посев на вызовы, мы
    // получили бы commit после каждого DELETE, и упавшая на середине
    // вставка оставила бы стенд без строк клиента вовсе.
    const seeds = sent.filter((item) => item.kind === "many");
    assertEquals(seeds.length, 2, "по одному посеву на sl-1 и sl-0");
    const sl1 = seeds.find((item) => item.port === 5441)!;
    assertStringIncludes(sl1.sql, "SET session_replication_role = replica");
    assertStringIncludes(sl1.sql, "DELETE FROM public.clients");
    assertStringIncludes(sl1.sql, "DELETE FROM public.spreadsheets_sheets");
    assertStringIncludes(sl1.sql, "UPDATE public.clients SET server = 'sl-1'");
  });
});

Deno.test("дети таблиц удаляются по объединению множеств", async () => {
  await withIo(async (io) => {
    const sent: Sent[] = [];
    const replies = new Map<string, SqlOutcome>();
    await runCopyClient({ selector: String(CLIENT) }, io, {
      runTool: tools([0, 0], []),
      openSession: (target, mode) => {
        const base = sessions(sent, replies)(target, mode);
        if (target.port !== 5441) return base;
        // На приёмнике остался ребёнок таблицы, которой на источнике
        // уже нет.
        return base.then((session) => ({
          ...session,
          query: (sql: string) =>
            sql.startsWith("SELECT spreadsheet_id")
              ? Promise.resolve(rows(["spreadsheet_id"], [["ss-осиротевший"]]))
              : session.query(sql),
        }));
      },
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
    });
    const seed = sent.find((item) =>
      item.port === 5441 && item.kind === "many"
    )!;
    // Удаление шире выборки: иначе строки таблицы, снесённой на
    // источнике, остались бы на стенде висеть сиротами. Значения ищем
    // среди параметров, а не в тексте: в текст они больше не попадают —
    // в этом и смысл правки.
    assertEquals(seed.params?.includes("ss-осиротевший"), true);
    assertEquals(seed.params?.includes("1BxiMVs0XRA5"), true);
    assertEquals(seed.sql.includes("ss-осиротевший"), false);
  });
});

Deno.test("отказ посева называет таблицу и говорит про откат", async () => {
  await withIo(async (io) => {
    const sent: Sent[] = [];
    const err = await assertRejects(
      () =>
        runCopyClient({ selector: String(CLIENT) }, io, {
          runTool: tools([0, 0], []),
          openSession: (target, mode) => {
            const base = sessions(sent)(target, mode);
            if (target.port !== 5441) return base;
            return base.then((session) => ({
              ...session,
              // Сервер отверг одну вставку: так и падал перенос на
              // jsonb-колонке, пока значения шли текстом.
              runMany: (statements: readonly Statement[]) => {
                const at = statements.findIndex((statement) =>
                  statement.label === "spreadsheets_sheets_values"
                );
                return Promise.reject(
                  new StatementError(
                    at,
                    statements[at]?.label,
                    new Error("invalid input syntax for type json"),
                  ),
                );
              },
            }));
          },
          tempFile: () => "/tmp/проба.dump",
          removeFile: () => {},
          nowMs: () => 0,
        }),
      DomainError,
    );
    // Не `unexpected error`: оператору нужны таблица и состояние
    // приёмника — по ним он решает, чинить данные или повторять.
    assertStringIncludes(err.message, "таблица spreadsheets_sheets_values");
    assertStringIncludes(err.message, "посев откачен целиком");
    assertStringIncludes(err.message, "invalid input syntax for type json");
    // Числа «перенесено» в тексте нет и быть не должно: транзакция одна
    // и откат полный, любое число читалось бы как «столько доехало».
    assertEquals(err.message.includes("перенесено"), false);
  });
});

Deno.test("отказ на служебном операторе не выдумывает таблицу", async () => {
  await withIo(async (io) => {
    const sent: Sent[] = [];
    const err = await assertRejects(
      () =>
        runCopyClient({ selector: String(CLIENT) }, io, {
          runTool: tools([0, 0], []),
          openSession: (target, mode) => {
            const base = sessions(sent)(target, mode);
            if (target.port !== 5441) return base;
            return base.then((session) => ({
              ...session,
              // Падает самый первый оператор — `SET
              // session_replication_role`, он требует суперпользователя.
              // Таблицей он не является, и называть её нечем.
              runMany: (statements: readonly Statement[]) =>
                Promise.reject(
                  new StatementError(
                    0,
                    statements[0]?.label,
                    new Error("permission denied to set parameter"),
                  ),
                ),
            }));
          },
          tempFile: () => "/tmp/проба.dump",
          removeFile: () => {},
          nowMs: () => 0,
        }),
      DomainError,
    );
    assertStringIncludes(err.message, "оператор 1 (session_replication_role)");
    // Прежняя форма подставляла сюда сумму строк всех таблиц: метки в
    // счётчиках нет, и поиск по ней давал -1, то есть «весь список».
    assertEquals(err.message.includes("прочитано"), false);
  });
});

Deno.test("отказ фиксации — тоже доменная ошибка, а не трейсбек", async () => {
  await withIo(async (io) => {
    const sent: Sent[] = [];
    const err = await assertRejects(
      () =>
        runCopyClient({ selector: String(CLIENT) }, io, {
          runTool: tools([0, 0], []),
          openSession: (target, mode) => {
            const base = sessions(sent)(target, mode);
            if (target.port !== 5441) return base;
            return base.then((session) => ({
              ...session,
              // Отказ `COMMIT` (отложенный констрейнт) не относится ни к
              // одному оператору списка: `StatementError` его не несёт.
              runMany: () =>
                Promise.reject(new Error("deferred constraint violated")),
            }));
          },
          tempFile: () => "/tmp/проба.dump",
          removeFile: () => {},
          nowMs: () => 0,
        }),
      DomainError,
    );
    assertStringIncludes(err.message, "перенос строк: ");
    assertStringIncludes(err.message, "deferred constraint violated");
  });
});

Deno.test("вход в sw-front заводится и печатается", async () => {
  await withIo(async (io) => {
    const lines: string[] = [];
    const sent: Sent[] = [];
    const loud = { ...io, progress: (line: string) => void lines.push(line) };
    const result = await runCopyClient({ selector: String(CLIENT) }, loud, {
      runTool: tools([0, 0], []),
      openSession: sessions(sent),
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
    });

    assertEquals(result.login, true);
    const seed = sent.find((item) =>
      item.port === 5451 && item.sql.includes("INSERT INTO public.users")
    );
    assertEquals(seed !== undefined, true, "проводка не выполнялась");
    // Идемпотентно: второй пользователь с тем же адресом сделал бы
    // вход неоднозначным.
    assertStringIncludes(seed!.sql, "ON CONFLICT (email) DO UPDATE");
    assertStringIncludes(seed!.sql, "client_5175@local.host");
    // Строки про вход печатаются только при удавшейся проводке.
    const text = renderCopyClient(result);
    assertStringIncludes(text, "✓ вход: http://sw.localhost/login");
    assertStringIncludes(text, "client_5175@local.host / 123123");
  });
});

Deno.test("сбой проводки не роняет копию", async () => {
  await withIo(async (io) => {
    const lines: string[] = [];
    const loud = { ...io, progress: (line: string) => void lines.push(line) };
    const result = await runCopyClient({ selector: String(CLIENT) }, loud, {
      runTool: tools([0, 0], []),
      openSession: (target, mode) =>
        target.port === 5451
          ? Promise.reject(new Error("workspaces недоступна"))
          : sessions([])(target, mode),
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
    });

    // Шаг best-effort: копия схемы и строк уже готова, и ронять её
    // из-за проводки нечего — она догоняется повторным запуском.
    assertEquals(result.login, false);
    // Текст дословно из спеки, включая префикс команды.
    assertStringIncludes(
      lines.join("\n"),
      "mpu copy-client: WARN проводка sw-front не удалась",
    );
    // И обещания входа в итоге нет.
    assertEquals(renderCopyClient(result).includes("вход:"), false);
  });
});

Deno.test("кэш main греется строкой клиента из sl-0", async () => {
  await withIo(async (io) => {
    const redis: { argv: readonly string[]; stdin: string }[] = [];
    await runCopyClient({ selector: String(CLIENT) }, io, {
      runTool: tools([0, 0], []),
      openSession: (target, mode) => {
        const base = sessions([])(target, mode);
        if (target.port !== 5440) return base;
        return base.then((session) => ({
          ...session,
          query: (sql: string) =>
            sql.includes("row_to_json")
              ? Promise.resolve(rows(["row_to_json"], [['{"id":5175}']]))
              : session.query(sql),
        }));
      },
      runRedis: (argv, stdin) => {
        redis.push({ argv: [...argv], stdin });
        return Promise.resolve();
      },
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
    });

    assertEquals(redis.length, 1);
    assertEquals(redis[0].argv.includes("mp-sl-0-redis"), true);
    assertEquals(redis[0].argv.includes("sl-main:clients:5175"), true);
    // Значение уходит через stdin (`-x`), а не аргументом: строка
    // клиента бывает длинной и содержит что угодно.
    assertEquals(redis[0].argv.includes("-x"), true);
    assertEquals(redis[0].stdin, '{"id":5175}');
  });
});
