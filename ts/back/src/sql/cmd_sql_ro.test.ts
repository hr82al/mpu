/**
 * Порядок шагов вызова `mpu sql-ro` (`docs/specs/sql-ro.md`): проверка
 * флагов, маршрут, резолв, источник SQL, мета-блок, read-only-сессия и
 * классы отказов. Живого PostgreSQL нет — сессия подставляется портом
 * `session.ts`; кэш-БД настоящая, во временном файле (как в тестах
 * резолва).
 *
 * Мета-блоки сверяются с эталонами канала (`testdata/`, копии — в
 * `fixtures_test.ts`): плейсхолдеры подставляет тест.
 */

import { describe, expect, it } from "vitest";
import { rejected } from "../testing/thrown.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCacheDb } from "../store/mod.ts";
import {
  type CacheDb,
  type CommandIo,
  DomainError,
  type EnvFile,
  formatCommandError,
  UsageError,
  VerbatimError,
} from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { runSql, type SqlArgs, type SqlResult } from "./mod.ts";
import { sqlRoCommand } from "./cmd_sql_ro.ts";
import type { SqlOutcome } from "./render.ts";
import {
  DbError,
  type OpenSession,
  TransactionEndedError,
  WriteRefusedError,
} from "./session.ts";
import type { PgTarget } from "./target.ts";

const PG_HOST = "10.0.0.1";
const DEV_HOST = "10.1.1.1";

const ENV: Readonly<Record<string, string>> = {
  pg_0: PG_HOST,
  pg_1: PG_HOST,
  pg_3: PG_HOST,
  PG_MY_USER_NAME: "u",
  PG_MY_USER_PASSWORD: "p",
  DEV_PG_HOST: DEV_HOST,
  DEV_PG_USER: "du",
  DEV_PG_PASSWORD: "dp",
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

function envFileOf(values: Readonly<Record<string, string>>): EnvFile {
  return {
    get: (name) => values[name],
    values: () => ({ ...values }),
    require: (name) => {
      const value = values[name];
      if (value !== undefined && value !== "") return value;
      throw new DomainError(
        `environment variable ${name} is not set. ` +
          "Add it to ~/.config/mpu/.env or export in shell.",
      );
    },
    set: () => Promise.reject(new Error("запись env-файла не ожидается")),
  };
}

/** Ответы сессии по тексту запроса; строка-ключ — начало текста. */
type Answer = SqlOutcome | Error;

const READ_ONLY_ON: SqlOutcome = {
  kind: "rows",
  columns: ["current_setting"],
  rows: [["on"]],
};

const DONE: SqlOutcome = { kind: "done", rowcount: -1 };

/**
 * Подставная сессия: помнит запросы, цели подключения и закрытие.
 * `asked` — все запросы по порядку, `ran` — только те, что ушли методом
 * обёртки (её форма проверяется на стороне драйвера, `pg_test.ts`).
 */
function fakeSessions(answer: (text: string) => Answer) {
  const asked: string[] = [];
  const ran: string[] = [];
  const targets: PgTarget[] = [];
  let closed = 0;
  const ask = (text: string) => {
    asked.push(text);
    const reply = answer(text);
    return reply instanceof Error
      ? Promise.reject(reply)
      : Promise.resolve(reply);
  };
  const open: OpenSession = (target) => {
    targets.push(target);
    return Promise.resolve({
      query: ask,
      run: (sql: string) => {
        ran.push(sql);
        return ask(sql);
      },
      // Пакетное исполнение этот тест не ожидает: объявлено, чтобы
      // случайное обращение к нему краснело, а не работало молча.
      runMany: () => Promise.reject(new Error("runMany не ожидается")),
      close: () => {
        closed += 1;
        return Promise.resolve();
      },
    });
  };
  return { open, asked, ran, targets, closed: () => closed };
}

/** Ответы по умолчанию: сессия read-only, пользовательский SQL — таблица. */
function answers(userOutcome: Answer = DONE): (text: string) => Answer {
  return (text) => {
    if (text.startsWith("SELECT current_setting")) return READ_ONLY_ON;
    if (text.startsWith("SET search_path")) return DONE;
    return userOutcome;
  };
}

/** Окружение вызова: env-файл, stdin и приёмник строк хода исполнения. */
function harness(overrides: Partial<CommandIo> = {}) {
  const progress: string[] = [];
  const io = makeFakeIo({
    envFile: envFileOf(ENV),
    progress: (line) => void progress.push(line),
    ...overrides,
  });
  return { io, progress, stderr: () => progress.map((l) => `${l}\n`).join("") };
}

function golden(name: string): Promise<string> {
  return readFile(new URL(`testdata/${name}`, import.meta.url), "utf8");
}

/**
 * Временная кэш-БД с одним клиентом на sl-3 и двумя его таблицами.
 * Каждый вызов открывателя даёт своё соединение — как в рантайме:
 * закрывает его тот, кто открыл.
 */
async function withCache(
  body: (open: () => CacheDb) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  const path = `${dir}/mpu.db`;
  try {
    {
      using seed = openCacheDb(path);
      seed.bootstrap();
      seed.execute(
        "INSERT INTO sl_clients (client_id, server, is_active, is_locked," +
          " is_deleted, synced_at) VALUES (42, 'sl-3', 1, 0, 0, 0)",
      );
      // Второй клиент того же сервера: селектор, совпавший с обоими,
      // однозначен по серверу, но не по клиенту.
      seed.execute(
        "INSERT INTO sl_clients (client_id, server, is_active, is_locked," +
          " is_deleted, synced_at) VALUES (43, 'sl-3', 1, 0, 0, 0)",
      );
      const sheets: readonly [string, number, string][] = [
        ["ss-a", 42, "Отчёт"],
        ["ss-b", 42, "Прайс общий"],
        ["ss-c", 43, "Смета общая"],
      ];
      for (const [ssId, clientId, title] of sheets) {
        seed.execute(
          "INSERT INTO sl_spreadsheets (ss_id, client_id, title," +
            " template_name, is_active, server, synced_at)" +
            " VALUES (?, ?, ?, NULL, 1, 'sl-3', 0)",
          ssId,
          clientId,
          title,
        );
      }
    }
    await body(() => openCacheDb(path));
  } finally {
    await rm(dir, { recursive: true });
  }
}

it("конфликт --json и --md проверяется первым", async () => {
  // Ни stdin, ни кэш, ни env-файл трогать нельзя: проверка идёт до
  // чтения SQL и до резолва (спека, «CLI-контракт»).
  const io = makeFakeIo({
    envFile: {
      get: () => {
        throw new Error("env-файл читаться не должен");
      },
      values: () => ({}),
      require: () => {
        throw new Error("env-файл читаться не должен");
      },
      set: () => Promise.reject(new Error("нет")),
    },
  });
  const err = await rejected(
    () =>
      runSql(args({ selector: "42", json: true, md: true }), io, {
        mode: "read-only",
      }),
    UsageError,
  );
  expect(formatCommandError("sql-ro", err)).toBe(
    "mpu sql-ro: --json и --md взаимоисключающие",
  );
});

it("--server не сочетается с dev-селектором", async () => {
  const { io } = harness();
  const err = await rejected(
    () =>
      runSql(args({ selector: "dev:42", server: "sl-1" }), io, {
        mode: "read-only",
      }),
    UsageError,
  );
  expect(err.message).toBe("--server не сочетается с dev-селектором");
});

describe("sw-селектор: отказ до чтения SQL", () => {
  // Маршрут выброшен целиком (порция 97). Алиасы распознаются ровно
  // ради этого отказа: без них селектор ушёл бы в обычный резолв и
  // упал бы «клиент не найден» — причиной не по делу.
  const aliases = [
    "sw",
    "SW",
    " sw-pg ",
    "swpg",
    "sw-back",
    "swback",
    "ws",
    "WorkSpaces",
  ];
  for (const selector of aliases) {
    it(`алиас ${JSON.stringify(selector)}`, async () => {
      const { io } = harness();
      const err = await rejected(
        () =>
          runSql(args({ selector, sql: "select 1" }), io, {
            mode: "read-only",
          }),
        UsageError,
      );
      expect(formatCommandError("sql-ro", err)).toBe(
        "mpu sql-ro: маршрут sw выброшен: доступа к контуру воркспейсов нет",
      );
    });
  }

  it("отказ приходит раньше чтения SQL", async () => {
    // Без аргумента SQL читался бы со stdin или с терминала: отказ
    // обязан опередить приглашение ко вводу.
    let read = false;
    const { io } = harness({
      readStdin: () => {
        read = true;
        return Promise.resolve(new TextEncoder().encode("select 1"));
      },
    });
    await expect(runSql(args({ selector: "sw" }), io, { mode: "read-only" }))
      .rejects.toThrow(UsageError);
    expect(read, "SQL прочитан до отказа").toBe(false);
  });
});

describe("источник SQL: аргумент, затем stdin, затем терминал", () => {
  it("аргумент побеждает, stdin не читается", async () => {
    const sessions = fakeSessions(answers());
    const { io } = harness();
    const result = await runSql(
      args({ selector: "sl-1", sql: "SELECT 1" }),
      io,
      { mode: "read-only", openSession: sessions.open },
    );
    expect(result.sql).toBe("SELECT 1");
  });

  it("аргумент из одних пробелов — как незаданный", async () => {
    const sessions = fakeSessions(answers());
    const { io, progress } = harness({
      readStdin: () => Promise.resolve(new TextEncoder().encode("SELECT 2\n")),
    });
    const result = await runSql(
      args({ selector: "sl-1", sql: "   " }),
      io,
      { mode: "read-only", openSession: sessions.open },
    );
    expect(result.sql).toBe("SELECT 2\n");
    // Приглашения в пайпе нет.
    expect(progress).toStrictEqual([]);
  });

  it("терминал: приглашение в stderr до чтения", async () => {
    const sessions = fakeSessions(answers());
    const { io, progress } = harness({
      stdinIsTerminal: () => true,
      readStdin: () => Promise.resolve(new TextEncoder().encode("SELECT 3")),
    });
    await runSql(args({ selector: "sl-1" }), io, {
      mode: "read-only",
      openSession: sessions.open,
    });
    expect(progress).toStrictEqual(["-- enter SQL, end with EOF (Ctrl+D):"]);
  });

  it("пустой итог — ошибка ввода без подключения", async () => {
    const sessions = fakeSessions(answers());
    const { io } = harness({
      readStdin: () => Promise.resolve(new TextEncoder().encode("  \n")),
    });
    const err = await rejected(() =>
      runSql(args({ selector: "sl-1" }), io, {
        mode: "read-only",
        openSession: sessions.open,
      }), UsageError);
    expect(err.message).toBe("empty SQL");
    expect(sessions.targets.length).toBe(0);
  });
});

describe("мета-блок: эталоны канала байт в байт", () => {
  const cases: readonly [string, string, SqlArgs][] = [
    [
      "dry-v-server-stderr.txt",
      "--server: резолва нет, search_path не ставится",
      args({ selector: "нет-такого", server: "sl-3", sql: "SELECT 1" }),
    ],
    [
      "dry-v-dev-stderr.txt",
      "dev-стенд: хвост-число даёт search_path",
      args({ selector: "dev:42", sql: "SELECT 1" }),
    ],
    [
      "dry-v-stderr.txt",
      "сервер целиком: mode: read-only без search_path",
      args({ selector: "sl-1", sql: "SELECT 1" }),
    ],
    [
      "dry-v-sl0-stderr.txt",
      "sl-0 — обычный сервер, кандидатов нет",
      args({ selector: "sl-0", sql: "SELECT 1" }),
    ],
  ];
  for (const [name, title, base] of cases) {
    it(`${name}: ${title}`, async () => {
      const sessions = fakeSessions(answers());
      const { io, stderr } = harness();
      const result = await runSql(
        { ...base, dry: true, verbose: true },
        io,
        { mode: "read-only", openSession: sessions.open },
      );
      const expected = (await golden(name))
        .replaceAll("<pg_host>", PG_HOST)
        .replaceAll("<dev_pg_host>", DEV_HOST)
        .replaceAll("<client_id>", "42")
        .replaceAll("<N>", "3");
      expect(stderr()).toStrictEqual(expected);
      // `--dry` не открывает соединений (инвариант спеки).
      expect(sessions.targets.length).toBe(0);
      expect(result.dry).toBe(true);
      expect(result.outcome).toStrictEqual(null);
    });
  }

  it(
    "dry-v-client-stderr.txt: резолв по client_id даёт search_path",
    async () => {
      await withCache(async (open) => {
        const sessions = fakeSessions(answers());
        const { io, stderr } = harness({ openCacheDb: open });
        await runSql(
          args({ selector: "42", sql: "SELECT 1", dry: true, verbose: true }),
          io,
          { mode: "read-only", openSession: sessions.open },
        );
        expect(stderr()).toStrictEqual(
          (await golden("dry-v-client-stderr.txt"))
            .replaceAll("<pg_host>", PG_HOST)
            .replaceAll("<client_id>", "42")
            .replaceAll("<N>", "3"),
        );
      });
    },
  );
});

describe("мета-блок печатается ⇔ --verbose или --dry", () => {
  it("обычный прогон молчит", async () => {
    const sessions = fakeSessions(answers());
    const { io, progress } = harness();
    await runSql(args({ selector: "sl-1", sql: "SELECT 1" }), io, {
      mode: "read-only",
      openSession: sessions.open,
    });
    expect(progress).toStrictEqual([]);
  });

  it("--dry без -v печатает тот же блок", async () => {
    const sessions = fakeSessions(answers());
    const { io, progress } = harness();
    await runSql(args({ selector: "sl-1", sql: "SELECT 1", dry: true }), io, {
      mode: "read-only",
      openSession: sessions.open,
    });
    expect(progress[0]).toBe("server: sl-1");
    expect(progress.at(-1)).toBe("SELECT 1");
  });

  it("SQL из stdin не удваивает перевод строки", async () => {
    const sessions = fakeSessions(answers());
    const { io, stderr } = harness({
      readStdin: () => Promise.resolve(new TextEncoder().encode("SELECT 1\n")),
    });
    await runSql(args({ selector: "sl-1", dry: true }), io, {
      mode: "read-only",
      openSession: sessions.open,
    });
    expect(stderr().endsWith("sql:\nSELECT 1\n"), stderr()).toBe(true);
  });

  it("-v при обычном прогоне: блок и результат", async () => {
    const sessions = fakeSessions(answers());
    const { io, progress } = harness();
    const result = await runSql(
      args({ selector: "sl-1", sql: "SELECT 1", verbose: true }),
      io,
      { mode: "read-only", openSession: sessions.open },
    );
    expect(progress.join("\n")).toContain("mode: read-only");
    expect(result.outcome).toStrictEqual(DONE);
  });
});

describe("search_path ставится ⇔ ровно один различный client_id", () => {
  it("один клиент — SET перед пользовательским SQL", async () => {
    await withCache(async (open) => {
      const sessions = fakeSessions(answers());
      const { io } = harness({ openCacheDb: open });
      const result = await runSql(
        args({ selector: "Отчёт", sql: "SELECT 1" }),
        io,
        { mode: "read-only", openSession: sessions.open },
      );
      expect(result.searchPath).toBe("schema_42");
      expect(sessions.asked).toStrictEqual([
        "SELECT current_setting('transaction_read_only')",
        'SET search_path TO "schema_42", public',
        "SELECT 1",
      ]);
    });
  });

  it("два разных client_id — search_path не ставится", async () => {
    await withCache(async (open) => {
      const sessions = fakeSessions(answers());
      const { io } = harness({ openCacheDb: open });
      // Оба клиента на одном сервере: резолв успешен, но клиент не один.
      const result = await runSql(
        args({ selector: "общ", sql: "SELECT 1" }),
        io,
        { mode: "read-only", openSession: sessions.open },
      );
      expect([result.server, result.searchPath]).toStrictEqual(["sl-3", null]);
      expect(sessions.asked.length).toBe(2);
    });
  });

  it("сервер целиком — кандидатов нет, SET нет", async () => {
    const sessions = fakeSessions(answers());
    const { io } = harness();
    const result = await runSql(
      args({ selector: "sl-1", sql: "SELECT 1" }),
      io,
      { mode: "read-only", openSession: sessions.open },
    );
    expect(result.searchPath).toStrictEqual(null);
    expect(sessions.asked.length).toBe(2);
  });

  it("dev с нечисловым хвостом — без search_path", async () => {
    const sessions = fakeSessions(answers());
    const { io } = harness();
    const result = await runSql(
      args({ selector: "dev:прод", sql: "SELECT 1" }),
      io,
      { mode: "read-only", openSession: sessions.open },
    );
    expect([result.server, result.searchPath]).toStrictEqual(["dev", null]);
    expect(result.host).toStrictEqual(DEV_HOST);
  });

  it("--server: кэш не открывается вовсе", async () => {
    const sessions = fakeSessions(answers());
    const { io } = harness({
      openCacheDb: () => {
        throw new Error("кэш-БД открываться не должна");
      },
    });
    const result = await runSql(
      args({ selector: "42", server: "sl-3", sql: "SELECT 1" }),
      io,
      { mode: "read-only", openSession: sessions.open },
    );
    expect([result.server, result.searchPath]).toStrictEqual(["sl-3", null]);
  });
});

describe("read-only проверяется на соединении до пользовательского SQL", () => {
  it("запрет не действует — отказ, SQL не исполнен", async () => {
    const sessions = fakeSessions((text) =>
      text.startsWith("SELECT current_setting")
        ? { kind: "rows", columns: ["c"], rows: [["off"]] }
        : DONE
    );
    const { io } = harness();
    const err = await rejected(() =>
      runSql(
        args({ selector: "sl-1", sql: "DROP TABLE x" }),
        io,
        {
          mode: "read-only",
          openSession: sessions.open,
        },
      ), DomainError);
    expect(err.message).toBe(
      "read-only сессия не действует на этом соединении — запрос не выполнен",
    );
    expect(sessions.asked).toStrictEqual([
      "SELECT current_setting('transaction_read_only')",
    ]);
    // Соединение закрыто при любом исходе.
    expect(sessions.closed()).toBe(1);
  });

  it("проверка идёт раньше SET search_path", async () => {
    await withCache(async (open) => {
      const sessions = fakeSessions((text) =>
        text.startsWith("SELECT current_setting")
          ? { kind: "rows", columns: ["c"], rows: [[null]] }
          : DONE
      );
      const { io } = harness({ openCacheDb: open });
      await expect(runSql(args({ selector: "42", sql: "SELECT 1" }), io, {
        mode: "read-only",
        openSession: sessions.open,
      })).rejects.toThrow(DomainError);
      expect(sessions.asked.length).toBe(1);
    });
  });
});

it("пользовательский текст исполняется обёрткой", async () => {
  const sessions = fakeSessions(answers());
  const { io } = harness();
  await runSql(args({ selector: "sl-1", sql: "SELECT 1" }), io, {
    mode: "read-only",
    openSession: sessions.open,
  });
  // Служебные запросы обёртки не получают: она откатила бы их действие
  // вместе со своей транзакцией (`platform/readonly-default.md`).
  expect(sessions.ran).toStrictEqual(["SELECT 1"]);
  expect(sessions.asked).toStrictEqual([
    "SELECT current_setting('transaction_read_only')",
    "SELECT 1",
  ]);
});

describe("отказы БД: свой текст на запись, дословный — на прочее", () => {
  it("write-refused-stderr.txt — текст спеки", async () => {
    const sessions = fakeSessions((text) =>
      text.startsWith("SELECT current_setting")
        ? READ_ONLY_ON
        : new WriteRefusedError(
          "cannot execute UPDATE in a read-only transaction",
        )
    );
    const { io } = harness();
    const err = await rejected(() =>
      runSql(
        args({ selector: "sl-1", sql: "UPDATE t SET a = 1" }),
        io,
        {
          mode: "read-only",
          openSession: sessions.open,
        },
      ), DomainError);
    expect(`${formatCommandError("sql-ro", err)}\n`).toStrictEqual(
      await golden("write-refused-stderr.txt"),
    );
    expect(sessions.closed()).toBe(1);
  });

  it("текст завершил транзакцию вызова — свой текст", async () => {
    // Метка обёртки потеряна: на остаток текста гарантия не действовала,
    // поэтому результат не печатается (`platform/readonly-default.md`).
    const sessions = fakeSessions((text) =>
      text.startsWith("SELECT current_setting")
        ? READ_ONLY_ON
        : new TransactionEndedError("no such savepoint: mpu_sql_ro")
    );
    const { io } = harness();
    const err = await rejected(() =>
      runSql(
        args({ selector: "sl-1", sql: "COMMIT; BEGIN READ WRITE; COMMIT" }),
        io,
        { mode: "read-only", openSession: sessions.open },
      ), DomainError);
    expect(formatCommandError("sql-ro", err)).toStrictEqual(
      "mpu sql-ro: метка транзакции вызова не снята — гарантия " +
        "только-чтения не подтверждена, результат не печатается",
    );
    expect(sessions.closed()).toBe(1);
  });

  it("имя метки не печатается ни на одном из путей", async () => {
    // Метка — имя реализации: на пути подменённой транзакции сервер
    // называет её в сообщении, и оно приходит команде в `cause`. Наружу
    // печатается один и тот же фиксированный текст, метки в нём нет.
    // Третий случай — текст пользователя сам ссылается на не
    // открывавшуюся точку сохранения при целой транзакции вызова и
    // целой метке обёртки: тем же кодом `3B001`, тот же отказ
    // (`platform/readonly-default.md`).
    for (
      const server of [
        "ROLLBACK TO SAVEPOINT can only be used in transaction blocks",
        'savepoint "mpu_sql_ro" does not exist',
        'savepoint "bar" does not exist',
      ]
    ) {
      const sessions = fakeSessions((text) =>
        text.startsWith("SELECT current_setting")
          ? READ_ONLY_ON
          : new TransactionEndedError(server)
      );
      const { io } = harness();
      const err = await rejected(() =>
        runSql(
          args({
            selector: "sl-1",
            sql: "ROLLBACK TO SAVEPOINT bar; SELECT 1",
          }),
          io,
          { mode: "read-only", openSession: sessions.open },
        ), DomainError);
      const shown = formatCommandError("sql-ro", err);
      expect(shown).toStrictEqual(
        "mpu sql-ro: метка транзакции вызова не снята — гарантия " +
          "только-чтения не подтверждена, результат не печатается",
      );
      expect(shown.includes("mpu_sql_ro"), shown).toBe(false);
      expect(shown.includes("bar"), shown).toBe(false);
      expect(sessions.closed()).toBe(1);
    }
  });

  it("отказ подключения — та же ошибка БД", async () => {
    // Соединения нет вовсе: отказ обязан прийти классом команды, иначе
    // недоступный хост печатался бы как «unexpected error».
    const { io } = harness();
    const err = await rejected(
      () =>
        runSql(args({ selector: "sl-1", sql: "SELECT 1" }), io, {
          mode: "read-only",
          openSession: () =>
            Promise.reject(new DbError("connect ECONNREFUSED 127.0.0.1:1")),
        }),
      VerbatimError,
    );
    expect(err.message).toBe("db error: connect ECONNREFUSED 127.0.0.1:1");
  });

  it("db-error-stderr.txt — текст сервера без префикса", async () => {
    const server = 'relation "nonexistent_table_xyz" does not exist\n' +
      "LINE 1: SELECT * FROM nonexistent_table_xyz\n" +
      "                      ^";
    const sessions = fakeSessions((text) =>
      text.startsWith("SELECT current_setting")
        ? READ_ONLY_ON
        : new DbError(server)
    );
    const { io } = harness();
    const err = await rejected(() =>
      runSql(
        args({
          selector: "sl-1",
          sql: "SELECT * FROM nonexistent_table_xyz",
        }),
        io,
        { mode: "read-only", openSession: sessions.open },
      ), VerbatimError);
    expect(`${formatCommandError("sql-ro", err)}\n`).toStrictEqual(
      await golden("db-error-stderr.txt"),
    );
  });
});

describe("результат и его рендер", () => {
  const outcome: SqlOutcome = {
    kind: "rows",
    columns: ["a"],
    rows: [[1]],
  };

  async function run(overrides: Partial<SqlArgs>): Promise<SqlResult> {
    const sessions = fakeSessions(answers(outcome));
    const { io } = harness();
    return await runSql(
      args({ selector: "sl-1", sql: "SELECT 1 AS a", ...overrides }),
      io,
      { mode: "read-only", openSession: sessions.open },
    );
  }

  it("умолчание — ASCII-таблица", async () => {
    const result = await run({});
    expect(sqlRoCommand.renderResult(result, ["sl-1", "SELECT 1 AS a"])).toBe(
      "a\n-\n1\n(1 rows)\n",
    );
  });

  it("--json — массив объектов одной строкой", async () => {
    const result = await run({ json: true });
    expect(
      sqlRoCommand.renderResult(result, ["sl-1", "SELECT 1 AS a", "--json"]),
    ).toBe('[{"a": 1}]\n');
  });

  it("--md — markdown-таблица", async () => {
    const result = await run({ md: true });
    expect(sqlRoCommand.renderResult(result, ["sl-1", "SELECT 1 AS a", "--md"]))
      .toBe("| a |\n| --- |\n| 1 |\n");
  });

  it("--dry — stdout пуст", async () => {
    const result = await run({ dry: true });
    expect(sqlRoCommand.renderResult(result, ["sl-1", "--dry"])).toBe("");
  });
});
