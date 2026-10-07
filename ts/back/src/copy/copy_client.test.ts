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

import { assert, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  redisRunner,
  renderCopyClient,
} from "./cmd_copy_client.ts";
import { DETACH_SQL } from "./sw_front.ts";
import { copyClientInTest as copyClient, noRedis } from "./testing.ts";
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
import { spawnRedis } from "./tools.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
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
    await rm(dir, { recursive: true });
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
      // Кабинет клиента: без него три оператора проводки не собираются
      // вовсе, и их порядок с параметрами остался бы непроверенным на
      // уровне команды.
      if (sql.includes("FROM public.clients_wb_cabinets")) {
        // Торговая марка NULL — форма, которую отдаёт свежий кабинет:
        // на уровне команды она обязана пройти сквозь подстановку и
        // дойти до вставки непустой.
        return rows(["sid", "name", "trade_mark"], [
          ["cab-1", "Магазин", null],
        ]);
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

it("порядок шага схемы: дамп раньше сноса цели", async () => {
  await withIo(async (io) => {
    const seen: Tool[] = [];
    const sent: Sent[] = [];
    const removed: string[] = [];
    await copyClient({ selector: String(CLIENT) }, io, {
      runTool: tools([0, 0], seen),
      openSession: sessions(sent),
      tempFile: () => "/tmp/проба.dump",
      removeFile: (path) => void removed.push(path),
      nowMs: () => 0,
      runRedis: noRedis,
    });

    expect(seen.map((tool) => tool.argv[0])).toStrictEqual([
      "pg_dump",
      "pg_restore",
    ]);
    // Снос цели стоит между дампом и восстановлением: до дампа он
    // необратимо снёс бы прежнюю копию, после восстановления — только
    // что восстановленную.
    const drop = sent.findIndex((item) => item.sql.includes("DROP SCHEMA"));
    expect(drop >= 0, "снос цели не выполнялся вовсе").toBe(true);
    expect(sent[drop].port).toBe(5441);
    expect(sent[drop].sql).toBe("DROP SCHEMA IF EXISTS schema_5175 CASCADE;");
    // …и он раньше первого пишущего запроса со строками клиента.
    const firstRows = sent.findIndex((item) =>
      item.sql.includes("DELETE FROM")
    );
    expect(drop < firstRows).toBe(true);
    // Дамп идёт с прод-инстанса, восстановление — в локальный sl-1.
    expect(seen[0].argv.includes("pg-prod-1.example.test")).toBe(true);
    expect(seen[1].argv.includes("127.0.0.1")).toBe(true);
    // Временный файл убран.
    expect(removed).toStrictEqual(["/tmp/проба.dump"]);
  });
});

it("упавший дамп не сносит цель и не восстанавливает", async () => {
  await withIo(async (io) => {
    const seen: Tool[] = [];
    const sent: Sent[] = [];
    const err = await copyClient({ selector: String(CLIENT) }, io, {
      runTool: tools([1], seen, ["pg_dump: error: connection failed"]),
      openSession: sessions(sent),
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
      runRedis: noRedis,
    }).catch((thrown: unknown) => thrown);
    assert(err instanceof DomainError);
    // `DROP SCHEMA … CASCADE` необратим: упавший дамп не должен стоить
    // оператору прежней копии.
    expect(seen.map((tool) => tool.argv[0])).toStrictEqual(["pg_dump"]);
    expect(sent.some((item) => item.sql.includes("DROP SCHEMA"))).toBe(false);
    expect(err.message).toContain("pg_dump schema_5175 failed (exit 1");
  });
});

it("ненулевой pg_restore — отказ с последней ошибкой инструмента", async () => {
  await withIo(async (io) => {
    const seen: Tool[] = [];
    const err = await copyClient({ selector: String(CLIENT) }, io, {
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
      runRedis: noRedis,
    }).catch((thrown: unknown) => thrown);
    assert(err instanceof DomainError);
    expect(err.message).toContain("pg_restore schema_5175 failed (exit 1");
    // Без последней ошибки оператор видит «failed» и не знает, что
    // 162 таблицы на месте.
    expect(err.message).toContain("errors ignored on restore: 1");
  });
});

it("запись идёт только в локальные приёмники", async () => {
  await withIo(async (io) => {
    const sent: Sent[] = [];
    await copyClient({ selector: String(CLIENT) }, io, {
      runTool: tools([0, 0], []),
      openSession: sessions(sent),
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
      runRedis: noRedis,
    });
    // Пишущие вызовы теперь двух видов: посев уходит списком
    // (`many`), проводка входа — одним текстом (`run`).
    const writes = sent.filter((item) => item.kind !== "query");
    // Прод (5432) не получает ни одного пишущего запроса: все DELETE,
    // INSERT и проводка входа уходят на локальные приёмники.
    expect([...new Set(writes.map((item) => item.port))]).toStrictEqual([
      5441,
      5440,
      5451,
    ]);
    const reads = sent.filter((item) => item.port === 5432);
    expect(reads.every((item) => item.kind === "query")).toBe(true);
    expect(reads.every((item) => item.sql.startsWith("SELECT"))).toBe(true);
  });
});

it("счётчики строк печатаются по каждой таблице", async () => {
  await withIo(async (io) => {
    const lines: string[] = [];
    const loud = { ...io, progress: (line: string) => void lines.push(line) };
    const result = await copyClient({ selector: String(CLIENT) }, loud, {
      runTool: tools([0, 0], []),
      openSession: sessions([]),
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
      runRedis: noRedis,
    });

    expect(result.clientId).toStrictEqual(CLIENT);
    expect(result.schema).toBe("schema_5175");
    // По счётчикам оператор видит, что именно скопировалось: «готово»
    // без чисел не отличить от пустой копии.
    expect(lines.join("\n")).toContain("  sl-1 clients: 1");
    expect(lines.join("\n")).toContain("  sl-1 spreadsheets: 1");
    expect(lines.join("\n")).toContain("  sl-0 wb_tokens: 1");
    expect(result.sl1.some((count) => count.table === "spreadsheets_sheets"))
      .toBe(true);
    // Дети таблиц переносятся по множеству spreadsheet_id клиента.
    expect(result.sl0.some((count) => count.table === "spreadsheets")).toBe(
      false,
    );
  });
});

it("неподнятый локальный контейнер назван в отказе", async () => {
  await withIo(async (io) => {
    const err = await copyClient({ selector: String(CLIENT) }, io, {
      runTool: tools([0, 0], []),
      openSession: (target, mode) =>
        target.host === "127.0.0.1"
          ? Promise.reject(new Error("connection refused"))
          : sessions([])(target, mode),
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
      runRedis: noRedis,
    }).catch((thrown: unknown) => thrown);
    assert(err instanceof UsageError);
    // Сырой `connection refused` оставлял бы гадать, какой из трёх
    // контейнеров стенда не поднят.
    expect(err.message).toContain(LOCAL_CONTAINERS[5441]);
    expect(err.message).toContain("127.0.0.1:5441");
    expect(String(err.hint)).toContain("mpu mp-init");
  });
});

it("пароли уходят окружением, а не в argv", async () => {
  await withIo(async (io) => {
    const seen: Tool[] = [];
    await copyClient({ selector: String(CLIENT) }, io, {
      runTool: tools([0, 0], seen),
      openSession: sessions([]),
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
      runRedis: noRedis,
    });
    for (const tool of seen) {
      // argv виден в `ps` любому пользователю машины, и печатается он
      // же — перед запуском.
      expect(tool.argv.includes("прод-пароль")).toBe(false);
      expect(tool.argv.includes("локальный-пароль")).toBe(false);
    }
    expect(seen[0].env.PGPASSWORD).toBe("прод-пароль");
    expect(seen[1].env.PGPASSWORD).toBe("локальный-пароль");
  });
});

it("селектор без единственного client_id — ошибка ввода", async () => {
  await withIo(async (io) => {
    await expect(copyClient({ selector: "sl-1" }, io, {
      runTool: tools([0, 0], []),
      openSession: sessions([]),
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
      runRedis: noRedis,
    })).rejects.toThrow(UsageError);
  });
});

it("источник открывается только на чтение", async () => {
  await withIo(async (io) => {
    const sent: Sent[] = [];
    await copyClient({ selector: String(CLIENT) }, io, {
      runTool: tools([0, 0], []),
      openSession: sessions(sent),
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
      runRedis: noRedis,
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
    expect([...(modes.get(5432) ?? [])]).toStrictEqual(["read-only"]);
    // У локальных приёмников режим записи; sl-1 читается ещё и для
    // кабинетов проводки, поэтому у него оба.
    expect([...(modes.get(5440) ?? [])].includes("write")).toBe(true);
    expect([...(modes.get(5451) ?? [])]).toStrictEqual(["write"]);
  });
});

it("посев уходит одной транзакцией на приёмник", async () => {
  await withIo(async (io) => {
    const sent: Sent[] = [];
    await copyClient({ selector: String(CLIENT) }, io, {
      runTool: tools([0, 0], []),
      openSession: sessions(sent),
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
      runRedis: noRedis,
    });
    // Каждый `run` — своя транзакция: разбив посев на вызовы, мы
    // получили бы commit после каждого DELETE, и упавшая на середине
    // вставка оставила бы стенд без строк клиента вовсе.
    // Списком уходит и проводка входа (шаг 6), но она — на своём порту
    // (5451, БД воркспейсов). Отбор по порту устойчивее отбора по
    // DELETE: перестань посев начинаться с удаления, и проверка молча
    // сменила бы предмет.
    const seeds = sent.filter((item) =>
      item.kind === "many" && item.port !== 5451
    );
    expect(seeds.length, "по одному посеву на sl-1 и sl-0").toBe(2);
    const sl1 = seeds.find((item) => item.port === 5441)!;
    expect(sl1.sql).toContain("SET session_replication_role = replica");
    expect(sl1.sql).toContain("DELETE FROM public.clients");
    expect(sl1.sql).toContain("DELETE FROM public.spreadsheets_sheets");
    expect(sl1.sql).toContain("UPDATE public.clients SET server = 'sl-1'");
  });
});

it("дети таблиц удаляются по объединению множеств", async () => {
  await withIo(async (io) => {
    const sent: Sent[] = [];
    const replies = new Map<string, SqlOutcome>();
    await copyClient({ selector: String(CLIENT) }, io, {
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
      runRedis: noRedis,
    });
    const seed = sent.find((item) =>
      item.port === 5441 && item.kind === "many"
    )!;
    // Удаление шире выборки: иначе строки таблицы, снесённой на
    // источнике, остались бы на стенде висеть сиротами. Значения ищем
    // среди параметров, а не в тексте: в текст они больше не попадают —
    // в этом и смысл правки.
    expect(seed.params?.includes("ss-осиротевший")).toBe(true);
    expect(seed.params?.includes("1BxiMVs0XRA5")).toBe(true);
    expect(seed.sql.includes("ss-осиротевший")).toBe(false);
  });
});

it("отказ посева называет таблицу и говорит про откат", async () => {
  await withIo(async (io) => {
    const sent: Sent[] = [];
    const err = await copyClient({ selector: String(CLIENT) }, io, {
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
      runRedis: noRedis,
    }).catch((thrown: unknown) => thrown);
    assert(err instanceof DomainError);
    // Не `unexpected error`: оператору нужны таблица и состояние
    // приёмника — по ним он решает, чинить данные или повторять.
    expect(err.message).toContain("таблица spreadsheets_sheets_values");
    expect(err.message).toContain("посев откачен целиком");
    expect(err.message).toContain("invalid input syntax for type json");
    // Числа «перенесено» в тексте нет и быть не должно: транзакция одна
    // и откат полный, любое число читалось бы как «столько доехало».
    expect(err.message.includes("перенесено")).toBe(false);
  });
});

it("отказ на служебном операторе не выдумывает таблицу", async () => {
  await withIo(async (io) => {
    const sent: Sent[] = [];
    const err = await copyClient({ selector: String(CLIENT) }, io, {
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
      runRedis: noRedis,
    }).catch((thrown: unknown) => thrown);
    assert(err instanceof DomainError);
    expect(err.message).toContain("оператор 1 (session_replication_role)");
    // Прежняя форма подставляла сюда сумму строк всех таблиц: метки в
    // счётчиках нет, и поиск по ней давал -1, то есть «весь список».
    expect(err.message.includes("прочитано")).toBe(false);
  });
});

it("отказ фиксации — тоже доменная ошибка, а не трейсбек", async () => {
  await withIo(async (io) => {
    const sent: Sent[] = [];
    const err = await copyClient({ selector: String(CLIENT) }, io, {
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
      runRedis: noRedis,
    }).catch((thrown: unknown) => thrown);
    assert(err instanceof DomainError);
    expect(err.message).toContain("перенос строк: ");
    expect(err.message).toContain("deferred constraint violated");
  });
});

it("вход в sw-front заводится и печатается", async () => {
  await withIo(async (io) => {
    const lines: string[] = [];
    const sent: Sent[] = [];
    const loud = { ...io, progress: (line: string) => void lines.push(line) };
    const result = await copyClient({ selector: String(CLIENT) }, loud, {
      runTool: tools([0, 0], []),
      openSession: sessions(sent),
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
      runRedis: noRedis,
    });

    expect(result.login).toBe(true);
    const seed = sent.find((item) =>
      item.port === 5451 && item.sql.includes("INSERT INTO public.users")
    );
    expect(seed !== undefined, "проводка не выполнялась").toBe(true);
    // Идемпотентно: второй пользователь с тем же адресом сделал бы
    // вход неоднозначным.
    expect(seed!.sql).toContain("ON CONFLICT (email) DO UPDATE");
    // Адрес — в параметрах, а не в тексте: значения проводки уходят
    // параметрами так же, как значения посева.
    expect(seed!.params?.includes("client_5175@local.host")).toBe(true);
    expect(seed!.sql.includes("client_5175@local.host")).toBe(false);
    // Кабинет доехал до всех трёх своих операторов, и его sid — тоже
    // параметром.
    expect(seed!.sql).toContain("INSERT INTO public.wb_cabinets");
    expect(seed!.sql).toContain("INSERT INTO public.subscriptions");
    expect(seed!.params?.includes("cab-1")).toBe(true);
    expect(seed!.sql.includes("cab-1")).toBe(false);
    // NULL торговой марки заменён заголовком клиента, а не уехал NULL
    // в колонку, которая его не принимает.
    expect(seed!.params?.includes("client 5175")).toBe(true);
    // Строки про вход печатаются только при удавшейся проводке.
    const text = renderCopyClient(result);
    expect(text).toContain("✓ вход: http://sw.localhost/login");
    expect(text).toContain("client_5175@local.host / 123123");
  });
});

it("отказ проводки называет оператор, на котором встала", async () => {
  await withIo(async (io) => {
    const lines: string[] = [];
    const loud = { ...io, progress: (line: string) => void lines.push(line) };
    const result = await copyClient({ selector: String(CLIENT) }, loud, {
      runTool: tools([0, 0], []),
      openSession: (target, mode) => {
        const base = sessions([])(target, mode);
        if (target.port !== 5451) return base;
        return base.then((session) => ({
          ...session,
          runMany: (statements: readonly Statement[]) =>
            Promise.reject(
              new StatementError(
                1,
                statements[1]?.label,
                new Error(
                  'column "is_active" of relation "workspaces" ' +
                    "does not exist",
                ),
              ),
            ),
        }));
      },
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
      runRedis: noRedis,
    });

    expect(result.login).toBe(false);
    // Текст сервера таблицы называет не всегда («column does not
    // exist» её не назвал бы), а операторов в проводке пять — и все про
    // разные таблицы.
    expect(lines.join("\n")).toContain("не удалась (workspaces: ");
  });
});

it("сбой проводки не роняет копию", async () => {
  await withIo(async (io) => {
    const lines: string[] = [];
    const loud = { ...io, progress: (line: string) => void lines.push(line) };
    const result = await copyClient({ selector: String(CLIENT) }, loud, {
      runTool: tools([0, 0], []),
      openSession: (target, mode) =>
        target.port === 5451
          ? Promise.reject(new Error("workspaces недоступна"))
          : sessions([])(target, mode),
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
      runRedis: noRedis,
    });

    // Шаг best-effort: копия схемы и строк уже готова, и ронять её
    // из-за проводки нечего — она догоняется повторным запуском.
    expect(result.login).toBe(false);
    // Текст дословно из спеки, включая префикс команды.
    expect(lines.join("\n")).toContain(
      "mpu copy-client: WARN проводка sw-front не удалась",
    );
    // И обещания входа в итоге нет.
    expect(renderCopyClient(result).includes("вход:")).toBe(false);
  });
});

it("кэш main греется строкой клиента из sl-0", async () => {
  await withIo(async (io) => {
    const redis: { argv: readonly string[]; stdin: string }[] = [];
    await copyClient({ selector: String(CLIENT) }, io, {
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

    // Обращений к redis два и они разные: шаг 5 греет кэш main, шаг 6
    // сбрасывает кэш sw-back — без сброса он показывал бы прежнее
    // состояние поверх свежезаведённого входа.
    expect(redis.length).toBe(2);
    const main = redis.find((call) => call.argv.includes("mp-sl-0-redis"))!;
    expect(main.argv.includes("sl-main:clients:5175")).toBe(true);
    // Значение уходит через stdin (`-x`), а не аргументом: строка
    // клиента бывает длинной и содержит что угодно.
    expect(main.argv.includes("-x")).toBe(true);
    expect(main.stdin).toBe('{"id":5175}');
    const swBack = redis.find((call) => call.argv.includes("redis-dev"))!;
    expect(swBack.argv.includes("FLUSHALL")).toBe(true);
  });
});

it("сброс кэша sw-back не роняет уже заведённый вход", async () => {
  await withIo(async (io) => {
    const lines: string[] = [];
    const loud = { ...io, progress: (line: string) => void lines.push(line) };
    const result = await copyClient({ selector: String(CLIENT) }, loud, {
      runTool: tools([0, 0], []),
      openSession: sessions([]),
      // Сброс sw-back падает: вход к этому моменту уже заведён, и
      // ронять его из-за кэша нечего. Кэш main здесь не греется вовсе —
      // строки клиента в sl-0 у этого фейка нет, и шаг 5 выходит
      // раньше обращения к redis (см. соседний тест).
      runRedis: (argv) =>
        argv.includes("FLUSHALL")
          ? Promise.reject(new Error("redis-dev не запущен"))
          : Promise.resolve(),
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
    });
    expect(result.login).toBe(true);
    expect(lines.join("\n")).toContain(
      "mpu copy-client: WARN кэш sw-back не сброшен",
    );
  });
});

it("у шва redis есть умолчание: настоящий исполнитель", () => {
  // Проверяется именно умолчание, а не исполнение: подстановку теперь
  // передаёт каждый тест, поэтому её пропажа тестами не ловится, —
  // а пропажа умолчания оставила бы оба шага мёртвыми в бинаре, как и
  // было полгода (`copy-client.md`, «Известные ловушки окружения»).
  expect(redisRunner({})).toStrictEqual(spawnRedis);
  expect(redisRunner({ runRedis: noRedis })).toStrictEqual(noRedis);
});

it("отказ redis на кэше main — предупреждение, а не отказ", async () => {
  await withIo(async (io) => {
    const lines: string[] = [];
    const loud = { ...io, progress: (line: string) => void lines.push(line) };
    const result = await copyClient({ selector: String(CLIENT) }, loud, {
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
      // Кэш main не отвечает; копия к этому моменту уже перенесена, и
      // ронять её из-за кэша нечего — его греет и повторный запуск.
      runRedis: (argv) =>
        argv.includes("sl-main:clients:5175")
          ? Promise.reject(new Error("mp-sl-0-redis не запущен"))
          : Promise.resolve(),
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
    });
    expect(result.clientId).toStrictEqual(CLIENT);
    expect(lines.join("\n")).toContain(
      "mpu copy-client: WARN кэш main не обновлён",
    );
  });
});

it("нет строки клиента в sl-0 — кэш не греется и redis не зовётся", async () => {
  await withIo(async (io) => {
    const lines: string[] = [];
    const loud = { ...io, progress: (line: string) => void lines.push(line) };
    const seen: readonly string[][] = [];
    const calls: string[][] = [...seen];
    await copyClient({ selector: String(CLIENT) }, loud, {
      runTool: tools([0, 0], []),
      // Фейк на `row_to_json` не отвечает: строки клиента в sl-0 нет.
      openSession: sessions([]),
      runRedis: (argv) => {
        calls.push([...argv]);
        return Promise.resolve();
      },
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
    });
    expect(lines.join("\n")).toContain("кэш не грет");
    // Греть нечем — и обращения к кэшу main не было вовсе; единственный
    // вызов redis остаётся за шагом 6.
    expect(calls.some((argv) => argv.includes("mp-sl-0-redis"))).toBe(false);
    expect(calls.some((argv) => argv.includes("FLUSHALL"))).toBe(true);
  });
});

it("снятая чужая привязка названа оператору строкой, а не молчанием", async () => {
  await withIo(async (io) => {
    const lines: string[] = [];
    const loud = { ...io, progress: (line: string) => void lines.push(line) };
    await copyClient({ selector: String(CLIENT) }, loud, {
      runTool: tools([0, 0], []),
      openSession: (target, mode) => {
        const base = sessions([])(target, mode);
        if (target.port !== 5451) return base;
        return base.then((session) => ({
          ...session,
          // Приёмник сообщает, что одна чужая связка снята: узнать это
          // можно только у сервера.
          runMany: (statements: readonly Statement[]) =>
            Promise.resolve(
              statements.map((statement) => ({
                kind: "done",
                // Сервер сообщает: одна чужая связка снята.
                rowcount: statement.sql.startsWith(DETACH_SQL) ? 1 : 0,
              } as SqlOutcome)),
            ),
        }));
      },
      runRedis: noRedis,
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
    });
    // Это штатный исход переноса, а не сбой: обычная строка, не WARN.
    // Проверяется сама строка, а не весь вывод: WARN в прогоне бывают и
    // по другим поводам (здесь — пустой sl-0), и «нет WARN нигде»
    // утверждало бы больше, чем нужно.
    const notice = lines.find((line) => line.includes("снято чужих связок"));
    expect(notice).toBe("  sw-front: снято чужих связок кабинетов: 1");
  });
});

it("снимать было нечего — строки в выводе нет", async () => {
  await withIo(async (io) => {
    const lines: string[] = [];
    const loud = { ...io, progress: (line: string) => void lines.push(line) };
    // Подставной приёмник по умолчанию отвечает `rowcount: 0`, то есть
    // чужой привязки не было: повторный прогон подряд не должен
    // сообщать о снятии того, чего уже нет.
    await copyClient({ selector: String(CLIENT) }, loud, {
      runTool: tools([0, 0], []),
      openSession: sessions([]),
      runRedis: noRedis,
      tempFile: () => "/tmp/проба.dump",
      removeFile: () => {},
      nowMs: () => 0,
    });
    expect(lines.join("\n")).toContain("sw-front: кабинетов заведено");
    expect(lines.some((line) => line.includes("снято чужих связок"))).toBe(
      false,
    );
  });
});
