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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
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
import { runSqlRo, type SqlRoArgs, type SqlRoResult } from "./mod.ts";
import { sqlRoCommand } from "./cmd_sql_ro.ts";
import type { SqlOutcome } from "./render.ts";
import {
  DbError,
  type OpenReadOnlySession,
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
function args(overrides: Partial<SqlRoArgs> & { selector: string }): SqlRoArgs {
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
  const open: OpenReadOnlySession = (target) => {
    targets.push(target);
    return Promise.resolve({
      query: ask,
      run: (sql: string) => {
        ran.push(sql);
        return ask(sql);
      },
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
  return Deno.readTextFile(new URL(`testdata/${name}`, import.meta.url));
}

/**
 * Временная кэш-БД с одним клиентом на sl-3 и двумя его таблицами.
 * Каждый вызов открывателя даёт своё соединение — как в рантайме:
 * закрывает его тот, кто открыл.
 */
async function withCache(
  body: (open: () => CacheDb) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
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
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("конфликт --json и --md проверяется первым", async () => {
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
  const err = await assertRejects(
    () => runSqlRo(args({ selector: "42", json: true, md: true }), io),
    UsageError,
  );
  assertEquals(
    formatCommandError("sql-ro", err),
    "mpu sql-ro: --json и --md взаимоисключающие",
  );
});

Deno.test("--server не сочетается с dev-селектором", async () => {
  const { io } = harness();
  const err = await assertRejects(
    () => runSqlRo(args({ selector: "dev:42", server: "sl-1" }), io),
    UsageError,
  );
  assertEquals(err.message, "--server не сочетается с dev-селектором");
});

Deno.test("sw-селектор исполняет прежняя реализация", async (t) => {
  await t.step("в argv он опознаётся до разбора схемой", () => {
    const cases: readonly [readonly string[], boolean][] = [
      [["sw", "select 1"], true],
      [["--server", "sl-1", "sw"], true],
      [["--dry", "WorkSpaces"], true],
      [["--", "sw"], true],
      [["42", "select 1"], false],
      [["--server", "sw"], false],
      [[], false],
    ];
    for (const [argv, expected] of cases) {
      assertEquals(sqlRoCommand.bridge(argv), expected, argv.join(" "));
    }
  });

  await t.step("исполнение отказывает: это не путь CLI", async () => {
    const { io } = harness();
    await assertRejects(
      () => runSqlRo(args({ selector: "sw", sql: "select 1" }), io),
      DomainError,
      "sw-селектор",
    );
  });
});

Deno.test("источник SQL: аргумент, затем stdin, затем терминал", async (t) => {
  await t.step("аргумент побеждает, stdin не читается", async () => {
    const sessions = fakeSessions(answers());
    const { io } = harness();
    const result = await runSqlRo(
      args({ selector: "sl-1", sql: "SELECT 1" }),
      io,
      { openSession: sessions.open },
    );
    assertEquals(result.sql, "SELECT 1");
  });

  await t.step("аргумент из одних пробелов — как незаданный", async () => {
    const sessions = fakeSessions(answers());
    const { io, progress } = harness({
      readTextStdin: () => Promise.resolve("SELECT 2\n"),
    });
    const result = await runSqlRo(
      args({ selector: "sl-1", sql: "   " }),
      io,
      { openSession: sessions.open },
    );
    assertEquals(result.sql, "SELECT 2\n");
    // Приглашения в пайпе нет.
    assertEquals(progress, []);
  });

  await t.step("терминал: приглашение в stderr до чтения", async () => {
    const sessions = fakeSessions(answers());
    const { io, progress } = harness({
      stdinIsTerminal: () => true,
      readTextStdin: () => Promise.resolve("SELECT 3"),
    });
    await runSqlRo(args({ selector: "sl-1" }), io, {
      openSession: sessions.open,
    });
    assertEquals(progress, ["-- enter SQL, end with EOF (Ctrl+D):"]);
  });

  await t.step("пустой итог — ошибка ввода без подключения", async () => {
    const sessions = fakeSessions(answers());
    const { io } = harness({ readTextStdin: () => Promise.resolve("  \n") });
    const err = await assertRejects(
      () =>
        runSqlRo(args({ selector: "sl-1" }), io, {
          openSession: sessions.open,
        }),
      UsageError,
    );
    assertEquals(err.message, "empty SQL");
    assertEquals(sessions.targets.length, 0);
  });
});

Deno.test("мета-блок: эталоны канала байт в байт", async (t) => {
  const cases: readonly [string, string, SqlRoArgs][] = [
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
    await t.step(`${name}: ${title}`, async () => {
      const sessions = fakeSessions(answers());
      const { io, stderr } = harness();
      const result = await runSqlRo(
        { ...base, dry: true, verbose: true },
        io,
        { openSession: sessions.open },
      );
      const expected = (await golden(name))
        .replaceAll("<pg_host>", PG_HOST)
        .replaceAll("<dev_pg_host>", DEV_HOST)
        .replaceAll("<client_id>", "42")
        .replaceAll("<N>", "3");
      assertEquals(stderr(), expected);
      // `--dry` не открывает соединений (инвариант спеки).
      assertEquals(sessions.targets.length, 0);
      assertEquals(result.dry, true);
      assertEquals(result.outcome, null);
    });
  }

  await t.step(
    "dry-v-client-stderr.txt: резолв по client_id даёт search_path",
    async () => {
      await withCache(async (open) => {
        const sessions = fakeSessions(answers());
        const { io, stderr } = harness({ openCacheDb: open });
        await runSqlRo(
          args({ selector: "42", sql: "SELECT 1", dry: true, verbose: true }),
          io,
          { openSession: sessions.open },
        );
        assertEquals(
          stderr(),
          (await golden("dry-v-client-stderr.txt"))
            .replaceAll("<pg_host>", PG_HOST)
            .replaceAll("<client_id>", "42")
            .replaceAll("<N>", "3"),
        );
      });
    },
  );
});

Deno.test("мета-блок печатается ⇔ --verbose или --dry", async (t) => {
  await t.step("обычный прогон молчит", async () => {
    const sessions = fakeSessions(answers());
    const { io, progress } = harness();
    await runSqlRo(args({ selector: "sl-1", sql: "SELECT 1" }), io, {
      openSession: sessions.open,
    });
    assertEquals(progress, []);
  });

  await t.step("--dry без -v печатает тот же блок", async () => {
    const sessions = fakeSessions(answers());
    const { io, progress } = harness();
    await runSqlRo(args({ selector: "sl-1", sql: "SELECT 1", dry: true }), io, {
      openSession: sessions.open,
    });
    assertEquals(progress[0], "server: sl-1");
    assertEquals(progress.at(-1), "SELECT 1");
  });

  await t.step("SQL из stdin не удваивает перевод строки", async () => {
    const sessions = fakeSessions(answers());
    const { io, stderr } = harness({
      readTextStdin: () => Promise.resolve("SELECT 1\n"),
    });
    await runSqlRo(args({ selector: "sl-1", dry: true }), io, {
      openSession: sessions.open,
    });
    assertEquals(stderr().endsWith("sql:\nSELECT 1\n"), true, stderr());
  });

  await t.step("-v при обычном прогоне: блок и результат", async () => {
    const sessions = fakeSessions(answers());
    const { io, progress } = harness();
    const result = await runSqlRo(
      args({ selector: "sl-1", sql: "SELECT 1", verbose: true }),
      io,
      { openSession: sessions.open },
    );
    assertStringIncludes(progress.join("\n"), "mode: read-only");
    assertEquals(result.outcome, DONE);
  });
});

Deno.test("search_path ставится ⇔ ровно один различный client_id", async (t) => {
  await t.step("один клиент — SET перед пользовательским SQL", async () => {
    await withCache(async (open) => {
      const sessions = fakeSessions(answers());
      const { io } = harness({ openCacheDb: open });
      const result = await runSqlRo(
        args({ selector: "Отчёт", sql: "SELECT 1" }),
        io,
        { openSession: sessions.open },
      );
      assertEquals(result.searchPath, "schema_42");
      assertEquals(sessions.asked, [
        "SELECT current_setting('transaction_read_only')",
        'SET search_path TO "schema_42", public',
        "SELECT 1",
      ]);
    });
  });

  await t.step("два разных client_id — search_path не ставится", async () => {
    await withCache(async (open) => {
      const sessions = fakeSessions(answers());
      const { io } = harness({ openCacheDb: open });
      // Оба клиента на одном сервере: резолв успешен, но клиент не один.
      const result = await runSqlRo(
        args({ selector: "общ", sql: "SELECT 1" }),
        io,
        { openSession: sessions.open },
      );
      assertEquals([result.server, result.searchPath], ["sl-3", null]);
      assertEquals(sessions.asked.length, 2);
    });
  });

  await t.step("сервер целиком — кандидатов нет, SET нет", async () => {
    const sessions = fakeSessions(answers());
    const { io } = harness();
    const result = await runSqlRo(
      args({ selector: "sl-1", sql: "SELECT 1" }),
      io,
      { openSession: sessions.open },
    );
    assertEquals(result.searchPath, null);
    assertEquals(sessions.asked.length, 2);
  });

  await t.step("dev с нечисловым хвостом — без search_path", async () => {
    const sessions = fakeSessions(answers());
    const { io } = harness();
    const result = await runSqlRo(
      args({ selector: "dev:прод", sql: "SELECT 1" }),
      io,
      { openSession: sessions.open },
    );
    assertEquals([result.server, result.searchPath], ["dev", null]);
    assertEquals(result.host, DEV_HOST);
  });

  await t.step("--server: кэш не открывается вовсе", async () => {
    const sessions = fakeSessions(answers());
    const { io } = harness({
      openCacheDb: () => {
        throw new Error("кэш-БД открываться не должна");
      },
    });
    const result = await runSqlRo(
      args({ selector: "42", server: "sl-3", sql: "SELECT 1" }),
      io,
      { openSession: sessions.open },
    );
    assertEquals([result.server, result.searchPath], ["sl-3", null]);
  });
});

Deno.test("read-only проверяется на соединении до пользовательского SQL", async (t) => {
  await t.step("запрет не действует — отказ, SQL не исполнен", async () => {
    const sessions = fakeSessions((text) =>
      text.startsWith("SELECT current_setting")
        ? { kind: "rows", columns: ["c"], rows: [["off"]] }
        : DONE
    );
    const { io } = harness();
    const err = await assertRejects(
      () =>
        runSqlRo(args({ selector: "sl-1", sql: "DROP TABLE x" }), io, {
          openSession: sessions.open,
        }),
      DomainError,
    );
    assertEquals(
      err.message,
      "read-only сессия не действует на этом соединении — запрос не выполнен",
    );
    assertEquals(sessions.asked, [
      "SELECT current_setting('transaction_read_only')",
    ]);
    // Соединение закрыто при любом исходе.
    assertEquals(sessions.closed(), 1);
  });

  await t.step("проверка идёт раньше SET search_path", async () => {
    await withCache(async (open) => {
      const sessions = fakeSessions((text) =>
        text.startsWith("SELECT current_setting")
          ? { kind: "rows", columns: ["c"], rows: [[null]] }
          : DONE
      );
      const { io } = harness({ openCacheDb: open });
      await assertRejects(
        () =>
          runSqlRo(args({ selector: "42", sql: "SELECT 1" }), io, {
            openSession: sessions.open,
          }),
        DomainError,
      );
      assertEquals(sessions.asked.length, 1);
    });
  });
});

Deno.test("пользовательский текст исполняется обёрткой", async () => {
  const sessions = fakeSessions(answers());
  const { io } = harness();
  await runSqlRo(args({ selector: "sl-1", sql: "SELECT 1" }), io, {
    openSession: sessions.open,
  });
  // Служебные запросы обёртки не получают: она откатила бы их действие
  // вместе со своей транзакцией (`platform/readonly-default.md`).
  assertEquals(sessions.ran, ["SELECT 1"]);
  assertEquals(sessions.asked, [
    "SELECT current_setting('transaction_read_only')",
    "SELECT 1",
  ]);
});

Deno.test("отказы БД: свой текст на запись, дословный — на прочее", async (t) => {
  await t.step("write-refused-stderr.txt — текст спеки", async () => {
    const sessions = fakeSessions((text) =>
      text.startsWith("SELECT current_setting")
        ? READ_ONLY_ON
        : new WriteRefusedError(
          "cannot execute UPDATE in a read-only transaction",
        )
    );
    const { io } = harness();
    const err = await assertRejects(
      () =>
        runSqlRo(args({ selector: "sl-1", sql: "UPDATE t SET a = 1" }), io, {
          openSession: sessions.open,
        }),
      DomainError,
    );
    assertEquals(
      `${formatCommandError("sql-ro", err)}\n`,
      await golden("write-refused-stderr.txt"),
    );
    assertEquals(sessions.closed(), 1);
  });

  await t.step("текст завершил транзакцию вызова — свой текст", async () => {
    // Метка обёртки потеряна: на остаток текста гарантия не действовала,
    // поэтому результат не печатается (`platform/readonly-default.md`).
    const sessions = fakeSessions((text) =>
      text.startsWith("SELECT current_setting")
        ? READ_ONLY_ON
        : new TransactionEndedError("no such savepoint: mpu_sql_ro")
    );
    const { io } = harness();
    const err = await assertRejects(
      () =>
        runSqlRo(
          args({ selector: "sl-1", sql: "COMMIT; BEGIN READ WRITE; COMMIT" }),
          io,
          { openSession: sessions.open },
        ),
      DomainError,
    );
    assertEquals(
      formatCommandError("sql-ro", err),
      "mpu sql-ro: метка транзакции вызова не снята — гарантия " +
        "только-чтения не подтверждена, результат не печатается",
    );
    assertEquals(sessions.closed(), 1);
  });

  await t.step("имя метки не печатается ни на одном из путей", async () => {
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
      const err = await assertRejects(
        () =>
          runSqlRo(
            args({
              selector: "sl-1",
              sql: "ROLLBACK TO SAVEPOINT bar; SELECT 1",
            }),
            io,
            { openSession: sessions.open },
          ),
        DomainError,
      );
      const shown = formatCommandError("sql-ro", err);
      assertEquals(
        shown,
        "mpu sql-ro: метка транзакции вызова не снята — гарантия " +
          "только-чтения не подтверждена, результат не печатается",
      );
      assertEquals(shown.includes("mpu_sql_ro"), false, shown);
      assertEquals(shown.includes("bar"), false, shown);
      assertEquals(sessions.closed(), 1);
    }
  });

  await t.step("отказ подключения — та же ошибка БД", async () => {
    // Соединения нет вовсе: отказ обязан прийти классом команды, иначе
    // недоступный хост печатался бы как «unexpected error».
    const { io } = harness();
    const err = await assertRejects(
      () =>
        runSqlRo(args({ selector: "sl-1", sql: "SELECT 1" }), io, {
          openSession: () =>
            Promise.reject(new DbError("connect ECONNREFUSED 127.0.0.1:1")),
        }),
      VerbatimError,
    );
    assertEquals(err.message, "db error: connect ECONNREFUSED 127.0.0.1:1");
  });

  await t.step("db-error-stderr.txt — текст сервера без префикса", async () => {
    const server = 'relation "nonexistent_table_xyz" does not exist\n' +
      "LINE 1: SELECT * FROM nonexistent_table_xyz\n" +
      "                      ^";
    const sessions = fakeSessions((text) =>
      text.startsWith("SELECT current_setting")
        ? READ_ONLY_ON
        : new DbError(server)
    );
    const { io } = harness();
    const err = await assertRejects(
      () =>
        runSqlRo(
          args({
            selector: "sl-1",
            sql: "SELECT * FROM nonexistent_table_xyz",
          }),
          io,
          { openSession: sessions.open },
        ),
      VerbatimError,
    );
    assertEquals(
      `${formatCommandError("sql-ro", err)}\n`,
      await golden("db-error-stderr.txt"),
    );
  });
});

Deno.test("результат и его рендер", async (t) => {
  const outcome: SqlOutcome = {
    kind: "rows",
    columns: ["a"],
    rows: [[1]],
  };

  async function run(overrides: Partial<SqlRoArgs>): Promise<SqlRoResult> {
    const sessions = fakeSessions(answers(outcome));
    const { io } = harness();
    return await runSqlRo(
      args({ selector: "sl-1", sql: "SELECT 1 AS a", ...overrides }),
      io,
      { openSession: sessions.open },
    );
  }

  await t.step("умолчание — ASCII-таблица", async () => {
    const result = await run({});
    assertEquals(
      sqlRoCommand.renderResult(result, ["sl-1", "SELECT 1 AS a"]),
      "a\n-\n1\n(1 rows)\n",
    );
  });

  await t.step("--json — массив объектов одной строкой", async () => {
    const result = await run({ json: true });
    assertEquals(
      sqlRoCommand.renderResult(result, ["sl-1", "SELECT 1 AS a", "--json"]),
      '[{"a": 1}]\n',
    );
  });

  await t.step("--md — markdown-таблица", async () => {
    const result = await run({ md: true });
    assertEquals(
      sqlRoCommand.renderResult(result, ["sl-1", "SELECT 1 AS a", "--md"]),
      "| a |\n| --- |\n| 1 |\n",
    );
  });

  await t.step("--dry — stdout пуст", async () => {
    const result = await run({ dry: true });
    assertEquals(sqlRoCommand.renderResult(result, ["sl-1", "--dry"]), "");
  });
});
