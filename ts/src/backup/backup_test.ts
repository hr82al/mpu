/**
 * Копии таблиц `mpu backup-*` (`docs/specs/backup.md`): план, форма
 * запроса и мета-блок. Живого PostgreSQL в тестах нет — сессия
 * подставная, а `--dry` до неё и не доходит.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type CacheDb,
  formatCommandError,
  UsageError,
  VerbatimError,
} from "../command/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { DbError, type OpenSession } from "../sql/mod.ts";
import { backupCommands, runBackup } from "./cmd_backup.ts";
import { runCli } from "../entrypoint/mod.ts";
import { backupSql, dateSuffix, mskDateSuffix, schemaIdOf } from "./plan.ts";

/** Синтетический конфиг: девятый сервер, свой хост и порт. */
const ENV: Readonly<Record<string, string>> = {
  pg_9: "10.9.9.9",
  PG_PORT: "5432",
  PG_DB_NAME: "mp",
  PG_MY_USER_NAME: "probeuser",
  PG_MY_USER_PASSWORD: "проба",
};

const CLIENT = { id: 777, server: "sl-9", sheet: "SHEET123" };

const TABLE = { marketplace: "wb", table: "wb_unit_proto" } as const;

/** Команда по имени; опечатка обязана падать здесь, а не на голдене. */
function command(name: string) {
  const found = backupCommands.find((item) => item.path[0] === name);
  if (found === undefined) throw new Error(`команда ${name} не объявлена`);
  return found;
}

async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/backup/${name}`, import.meta.url),
  );
}

/** Кэш-БД с одним клиентом; `sheets` — сколько у него таблиц. */
async function withCache(
  sheets: number,
  body: (db: CacheDb) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    db.execute(
      "INSERT INTO sl_clients (client_id, server, is_active, is_locked," +
        " is_deleted, synced_at) VALUES (?, ?, 1, 0, 0, ?)",
      CLIENT.id,
      CLIENT.server,
      1_700_000_000,
    );
    for (let index = 0; index < sheets; index++) {
      db.execute(
        "INSERT INTO sl_spreadsheets (ss_id, client_id, title, is_active," +
          " server, synced_at) VALUES (?, ?, ?, 1, ?, ?)",
        `${CLIENT.sheet}-${index}`,
        CLIENT.id,
        `Таблица ${index}`,
        CLIENT.server,
        1_700_000_000,
      );
    }
    await body(db);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Порт вызова и накопленный stderr: мета-блок идёт ходом исполнения. */
function io(db: CacheDb, progress: string[] = []) {
  return makeFakeIo({
    progress: (line: string) => void progress.push(line),
    envFile: {
      get: (name: string) => ENV[name],
      require: (name: string) => {
        const value = ENV[name];
        if (value === undefined) throw new Error(`нет ключа ${name}`);
        return value;
      },
      set: () => Promise.reject(new Error("запись env-файла не ожидается")),
      values: () => ({ ...ENV }),
    },
    openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }),
  });
}

/** Подставная сессия: помнит запрос и факт закрытия. */
function fakeSession(failWith?: Error) {
  const sent: string[] = [];
  let closed = false;
  let opened = 0;
  const open: OpenSession = () => {
    opened += 1;
    return session();
  };
  const session = () =>
    Promise.resolve({
      query: () => Promise.resolve({ kind: "done", rowcount: -1 } as const),
      run: (sql: string) => {
        sent.push(sql);
        if (failWith !== undefined) return Promise.reject(failWith);
        return Promise.resolve({ kind: "done", rowcount: 0 } as const);
      },
      // Пакетное исполнение этот тест не ожидает: объявлено, чтобы
      // случайное обращение к нему краснело, а не работало молча.
      runMany: () => Promise.reject(new Error("runMany не ожидается")),
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    });
  return { open, sent, wasClosed: () => closed, openedCount: () => opened };
}

const args = (overrides: Record<string, unknown> = {}) => ({
  selector: String(CLIENT.id),
  date: "20260827",
  "schema-id": undefined,
  server: undefined,
  dry: true,
  ...overrides,
});

Deno.test("--dry: мета-блок и запрос — эталон канала, в stderr", async () => {
  await withCache(1, async (db) => {
    const progress: string[] = [];
    const result = await runBackup(TABLE, args(), io(db, progress));
    // Блок целиком в stderr: у команды нет данных результата, и stdout
    // не используется вовсе (`backup.md`, отклонение `fix`).
    assertEquals(
      `${progress.join("\n")}\n`,
      await golden("backup-dry-stderr.txt"),
    );
    // Сравнение именно с пустой строкой: «не содержит marketplace»
    // пропустило бы частичную утечку в stdout.
    assertEquals(
      command("backup-wb-unit-proto").renderResult(result, [
        "777",
        "--date",
        "20260827",
        "--dry",
      ]),
      "",
    );
  });
});

Deno.test("выполнение: stdout пуст, блок в stderr", async () => {
  await withCache(1, async (db) => {
    const progress: string[] = [];
    const session = fakeSession();
    const result = await runBackup(
      TABLE,
      args({ dry: false }),
      io(db, progress),
      { openSession: session.open },
    );
    assertEquals(session.sent.length, 1, "запрос серверу не ушёл");
    // Тот же блок, что и в показе, — записью о том, что было сделано.
    assertEquals(
      `${progress.join("\n")}\n`,
      await golden("backup-dry-stderr.txt"),
    );
    assertEquals(
      command("backup-wb-unit-proto").renderResult(result, ["777"]),
      "",
    );
  });
});

Deno.test("по CLI: stdout пуст, блок печатает точка входа", async () => {
  // Проверка наблюдаемого: сам поток выбирает не команда, а точка
  // входа, и утверждение о `renderResult` выше о ней ничего не знает.
  await withCache(1, async (db) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      ["backup-wb-unit-proto", "777", "--date", "20260827", "--dry"],
      io(db),
      {
        stdout: (text) => void out.push(text),
        stderr: (text) => void err.push(text),
      },
    );
    assertEquals(code, 0);
    assertEquals(out.join(""), "", "stdout не пуст");
    assertEquals(err.join(""), await golden("backup-dry-stderr.txt"));
  });
});

Deno.test("--dry не подключается вовсе", async () => {
  await withCache(1, async (db) => {
    const session = fakeSession();
    await runBackup(TABLE, args(), io(db), { openSession: session.open });
    // Именно не открывается: пустой `sent` был бы верен и у открытого,
    // но не использованного соединения.
    assertEquals(session.openedCount(), 0);
    assertEquals(session.sent, []);
    assertEquals(session.wasClosed(), false);
  });
});

Deno.test("без --dry запрос уходит сессии, и она закрывается", async () => {
  await withCache(1, async (db) => {
    const session = fakeSession();
    const result = await runBackup(TABLE, args({ dry: false }), io(db), {
      openSession: session.open,
    });
    assertEquals(session.sent, [
      "CREATE TABLE backups.wb_unit_proto_777_20260827 AS\n" +
      "SELECT * FROM schema_777.wb_unit_proto;",
    ]);
    assertEquals(session.wasClosed(), true);
    assertEquals(result.dry, false);
  });
});

Deno.test("три команды различаются таблицей и площадкой", async (t) => {
  const cases: readonly (readonly [string, string, string])[] = [
    ["backup-wb-unit-proto", "wb", "wb_unit_proto"],
    ["backup-ozon-unit-proto", "ozon", "ozon_unit_proto"],
    ["backup-wb-unit-manual-data", "wb", "wb_unit_manual_data"],
  ];
  for (const [name, marketplace, table] of cases) {
    await t.step(name, async () => {
      await withCache(1, async (db) => {
        const result = await command(name).invokeInput(args(), io(db)) as {
          marketplace: string;
          source_table: string;
          sql: string;
        };
        assertEquals(result.marketplace, marketplace);
        assertEquals(result.source_table, `schema_777.${table}`);
        assertStringIncludes(
          result.sql,
          `CREATE TABLE backups.${table}_777_20260827 AS`,
        );
        assertStringIncludes(result.sql, `FROM schema_777.${table};`);
      });
    });
  }
});

Deno.test("форма запроса: перевод строки перед SELECT", () => {
  assertEquals(
    backupSql(TABLE, 42, "20260101"),
    "CREATE TABLE backups.wb_unit_proto_42_20260101 AS\n" +
      "SELECT * FROM schema_42.wb_unit_proto;",
  );
});

Deno.test("--date: ровно восемь цифр", async (t) => {
  const bad = ["2026-08-27", "2026827", "202608271", "abcdefgh", ""];
  for (const value of bad) {
    await t.step(`отбивается '${value}'`, () => {
      const err = assertThrowsUsage(() => dateSuffix(value, 0));
      assertStringIncludes(err.message, `bad --date '${value}'`);
    });
  }
  await t.step("принимается 20260827", () => {
    assertEquals(dateSuffix("20260827", 0), "20260827");
  });
});

Deno.test("дефолт даты — по Москве, а не по машине", () => {
  // Граница суток по МСК — 21:00 UTC, и проверяется она в самой точке:
  // смещение, сдвинутое на минуту, обязано ронять этот тест.
  assertEquals(mskDateSuffix(Date.UTC(2026, 7, 27, 21, 0)), "20260828");
  assertEquals(
    mskDateSuffix(Date.UTC(2026, 7, 27, 20, 59, 59, 999)),
    "20260827",
  );
  assertEquals(mskDateSuffix(Date.UTC(2026, 7, 27, 22, 30)), "20260828");
});

Deno.test("отказ сервера приходит его текстом, сессия закрывается", async () => {
  await withCache(1, async (db) => {
    const session = fakeSession(
      new DbError(
        'relation "backups.wb_unit_proto_777_20260827" already exists',
      ),
    );
    const err = await assertRejects(
      () =>
        runBackup(TABLE, args({ dry: false }), io(db), {
          openSession: session.open,
        }),
      VerbatimError,
      "already exists",
    );
    // Дословно: текст сервера печатается без префикса команды.
    assertEquals(
      formatCommandError("backup-wb-unit-proto", err),
      'relation "backups.wb_unit_proto_777_20260827" already exists',
    );
    assertEquals(session.wasClosed(), true);
  });
});

Deno.test("schema_id: флаг, кандидаты, сам селектор", async (t) => {
  const candidate = (clientId: number | null) => ({
    clientId,
    spreadsheetId: null,
    title: null,
    server: "sl-9",
    serverNumber: 9,
    sids: [],
  });

  await t.step("явный флаг старше всего", () => {
    assertEquals(schemaIdOf(42, "777", [candidate(777)]), 42);
  });

  await t.step("единственный client_id кандидатов", () => {
    assertEquals(
      schemaIdOf(undefined, "Таблица", [candidate(777), candidate(777)]),
      777,
    );
  });

  await t.step("кандидатов нет, селектор — число", () => {
    assertEquals(schemaIdOf(undefined, " 777 ", []), 777);
  });

  await t.step("разные client_id — отказ с кандидатами", async () => {
    const err = assertThrowsUsage(() =>
      schemaIdOf(undefined, "Таблица", [candidate(777), candidate(778)])
    );
    assertEquals(
      `${formatCommandError("backup-wb-unit-proto", err)}\n`,
      await golden("err-ambiguous-client-stderr.txt"),
    );
  });

  await t.step("кандидатов нет, селектор не число — отказ", () => {
    const err = assertThrowsUsage(() => schemaIdOf(undefined, "sl-9", []));
    assertStringIncludes(
      err.message,
      "cannot derive client_id from selector 'sl-9'; pass --schema-id",
    );
  });
});

/** `assertThrows` для `UsageError` с возвратом самой ошибки. */
function assertThrowsUsage(body: () => unknown): UsageError {
  try {
    body();
  } catch (err) {
    if (err instanceof UsageError) return err;
    throw err;
  }
  throw new Error("ожидалась ошибка ввода, а её не было");
}

Deno.test("неверная дата отбивается до соединения", async () => {
  await withCache(1, async (db) => {
    const session = fakeSession();
    await assertRejects(
      () =>
        runBackup(TABLE, args({ date: "27.08.2026", dry: false }), io(db), {
          openSession: session.open,
        }),
      UsageError,
      "bad --date",
    );
    assertEquals(session.sent, []);
  });
});
