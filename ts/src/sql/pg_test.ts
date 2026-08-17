/**
 * Разбор ответов драйвера и его ошибок (`pg.ts`) — без сети: формы
 * ответа и объекты ошибок строятся литералами. Живого PostgreSQL у
 * тестов нет (`docs/specs/sql-ro.md`, «Golden-примеры»), а именно эти
 * функции переводят его ответ в наблюдаемое поведение команды.
 */

import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import driver from "pg";
import {
  clientOptions,
  dbError,
  type OpenClient,
  openPgSession,
  outcomeAt,
  outcomeOf,
  serverText,
  toValue,
} from "./pg.ts";
import {
  DbError,
  TransactionEndedError,
  WriteRefusedError,
} from "./session.ts";

/** Ошибка сервера как её отдаёт драйвер: SQLSTATE и позиция строками. */
function serverError(
  message: string,
  code: string,
  position?: string,
): Error {
  const err = new driver.DatabaseError(message, message.length, "error");
  Object.assign(err, { code, position });
  return err;
}

const ROWS = {
  fields: [{ name: "a" }, { name: "b" }],
  rows: [[1, "x"], [2, null]],
  rowCount: 2,
  command: "SELECT",
};

const SET = { fields: [], rows: [], rowCount: null, command: "SET" };

Deno.test("форма ответа зависит от числа операторов", async (t) => {
  await t.step("один оператор — объект результата", () => {
    assertEquals(outcomeOf(ROWS), {
      kind: "rows",
      columns: ["a", "b"],
      rows: [[1, "x"], [2, null]],
    });
  });

  await t.step("несколько операторов — массив, берётся названный", () => {
    // Ответ на текст в обёртке: результат пользовательского оператора
    // лежит под своим номером, соседи в счёт не идут.
    assertEquals(outcomeAt([SET, ROWS], 1), {
      kind: "rows",
      columns: ["a", "b"],
      rows: [[1, "x"], [2, null]],
    });
    assertEquals(outcomeAt([ROWS, SET], 1), { kind: "done", rowcount: -1 });
  });

  await t.step("оператора под номером нет — как оператор без строк", () => {
    // Текст из одного комментария операторов не даёт: печатается
    // `OK (rowcount=-1)`, а не отказ.
    assertEquals(outcomeAt([SET], 3), { kind: "done", rowcount: -1 });
  });

  await t.step("оператор без набора строк: rowCount null — это -1", () => {
    assertEquals(outcomeOf(SET), { kind: "done", rowcount: -1 });
    assertEquals(outcomeOf({ ...SET, rowCount: 0 }), {
      kind: "done",
      rowcount: 0,
    });
  });

  await t.step("выборка без строк остаётся набором строк", () => {
    assertEquals(outcomeOf({ ...ROWS, rows: [], rowCount: 0 }), {
      kind: "rows",
      columns: ["a", "b"],
      rows: [],
    });
  });
});

Deno.test("значение ячейки: JSON-представимое как есть, прочее текстом", async (t) => {
  const cases: readonly [string, unknown, unknown][] = [
    ["null остаётся null", null, null],
    ["undefined тоже null", undefined, null],
    ["число", 42, 42],
    ["numeric приходит строкой и строкой остаётся", "1.50", "1.50"],
    ["булево", true, true],
    ["json-структура сохраняется", { a: [1, null] }, { a: [1, null] }],
    ["массив разбирается поэлементно", [1, "x"], [1, "x"]],
    [
      "дата — текстовой формой",
      new Date(Date.UTC(2026, 7, 5, 9, 0, 0)),
      "2026-08-05T09:00:00.000Z",
    ],
    [
      "bytea — текстовой формой PostgreSQL",
      new Uint8Array([0, 255]),
      "\\x00ff",
    ],
    // `SELECT 'NaN'::float8` — JSON такого числа не представляет, и в
    // результате оно обязано быть текстом сервера, а не числом.
    ["NaN — текстовой формой", NaN, "NaN"],
    ["Infinity — текстовой формой", Infinity, "Infinity"],
    ["-Infinity — текстовой формой", -Infinity, "-Infinity"],
  ];
  for (const [title, value, expected] of cases) {
    await t.step(title, () => {
      assertEquals(toValue(value), expected);
    });
  }
});

Deno.test("ошибки драйвера в классы порта", async (t) => {
  await t.step("SQLSTATE 25006 — отказ записи, различается по коду", () => {
    const err = dbError(
      serverError("cannot execute UPDATE in a read-only transaction", "25006"),
      "UPDATE t SET a = 1",
      { mode: "read-only" },
    );
    assertInstanceOf(err, WriteRefusedError);
  });

  await t.step("прочий SQLSTATE — текст сервера с позицией", () => {
    const err = dbError(
      serverError(
        'relation "nonexistent_table_xyz" does not exist',
        "42P01",
        "15",
      ),
      "SELECT * FROM nonexistent_table_xyz",
      { mode: "read-only" },
    );
    assertInstanceOf(err, DbError);
    assertEquals(
      err.message,
      'relation "nonexistent_table_xyz" does not exist\n' +
        "LINE 1: SELECT * FROM nonexistent_table_xyz\n" +
        "                      ^",
    );
  });

  await t.step("сбой соединения — та же ошибка БД", () => {
    const err = dbError(new Error("connect ECONNREFUSED 127.0.0.1:5432"), "", {
      mode: "read-only",
    });
    assertInstanceOf(err, DbError);
    assertEquals(err.message, "connect ECONNREFUSED 127.0.0.1:5432");
  });
});

Deno.test("указатель на место ошибки", async (t) => {
  await t.step("позиция во второй строке считается от её начала", () => {
    // Позиция 15 — первый символ `nosuch`; префикс `LINE 2: ` — 8
    // символов, начало строки — 10-й символ запроса.
    assertEquals(
      serverText("boom", "SELECT 1\nFROM nosuch", "15"),
      `boom\nLINE 2: FROM nosuch\n${" ".repeat(13)}^`,
    );
  });

  await t.step("позиции нет — только сообщение сервера", () => {
    assertEquals(serverText("boom", "SELECT 1", undefined), "boom");
  });

  await t.step("позиция вне текста запроса игнорируется", () => {
    assertEquals(serverText("boom", "SELECT 1", "999"), "boom");
    assertEquals(serverText("boom", "SELECT 1", "0"), "boom");
    assertEquals(serverText("boom", "SELECT 1", "не число"), "boom");
  });

  await t.step("позиция считается в символах, а не в байтах", () => {
    // Кириллическая буква — два байта и один символ: указатель обязан
    // встать под `nosuch`, то есть под 17-м символом.
    assertEquals(
      serverText("boom", "SELECT 'ы' FROM nosuch", "17"),
      `boom\nLINE 1: SELECT 'ы' FROM nosuch\n${" ".repeat(24)}^`,
    );
  });
});

Deno.test("опции подключения: read-only и независимость от окружения", async (t) => {
  const target = {
    host: "10.0.0.1",
    port: 6432,
    database: "wb",
    username: "u",
    password: "p",
  };
  const options = clientOptions(target, "read-only");

  await t.step("сессия открывается read-only опцией стартового пакета", () => {
    // Единственный механизм запрета записи (`platform/readonly-default.md`):
    // сервер получает его в стартовом пакете, до всякого SQL.
    assertEquals(options.options, "-c default_transaction_read_only=on");
  });

  await t.step("адрес и креды — из аргумента, а не из окружения", () => {
    assertEquals(
      [options.host, options.port, options.database, options.user],
      ["10.0.0.1", 6432, "wb", "u"],
    );
  });

  await t.step("прочие опции заданы явно: окружение их не решает", () => {
    // Не переданную опцию драйвер ищет в `PG*` процесса — конфигурация
    // же живёт только в env-файле (`platform/env-file.md`).
    assertEquals(options.application_name, "mpu");
    assertEquals(options.ssl, false);
    assertEquals(options.sslnegotiation, "postgres");
    assertEquals(options.client_encoding, "UTF8");
    assertEquals(options.connectionTimeoutMillis, 0);
  });

  await t.step("дата берётся текстом сервера, число — разбором", () => {
    const parser = options.types.getTypeParser;
    // 1114 — timestamp: значение проходит насквозь.
    assertEquals(parser(1114)("2026-08-05 12:00:00"), "2026-08-05 12:00:00");
    // 23 — int4: разбирает драйвер, и это число, а не строка.
    assertEquals(parser(23)("42"), 42);
  });
});

const TARGET = {
  host: "10.0.0.1",
  port: 5432,
  database: "wb",
  username: "u",
  password: "p",
};

const BEGIN = { fields: [], rows: [], rowCount: null, command: "BEGIN" };
const MARK = { fields: [], rows: [], rowCount: null, command: "SAVEPOINT" };
const READ_ONLY = {
  fields: [{ name: "current_setting" }],
  rows: [["on"]],
  rowCount: 1,
  command: "SELECT",
};

/**
 * Подставной клиент драйвера: помнит отправленный текст и отвечает по
 * нему, как отвечал бы сервер. Живого PostgreSQL у тестов нет
 * (`docs/specs/sql-ro.md`, «Golden-примеры»).
 */
function fakeClient(
  reply: (text: string) => unknown,
  connect: () => Promise<void> = () => Promise.resolve(),
) {
  const sent: string[] = [];
  let ended = 0;
  const open: OpenClient = () => ({
    connect,
    query: ({ text }) => {
      sent.push(text);
      const answer = reply(text);
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    },
    end: () => {
      ended += 1;
      return Promise.resolve();
    },
  });
  return { open, sent, ended: () => ended };
}

/** Ответ сервера на успешно исполненную обёртку с одним оператором. */
function wrapped(user: unknown): readonly unknown[] {
  return [BEGIN, READ_ONLY, MARK, user, MARK, BEGIN];
}

Deno.test("пользовательский текст исполняется внутри обёртки", async (t) => {
  await t.step(
    "обёртка собрана дословно, текст пользователя как есть",
    async () => {
      const client = fakeClient(() => wrapped(ROWS));
      const session = await openPgSession(TARGET, "read-only", client.open);
      await session.run("SELECT 1 AS a; SELECT 2 AS b");
      await session.close();
      // Форма — `platform/readonly-default.md`: три оператора до текста
      // пользователя и два после, метка не из его ввода.
      assertEquals(client.sent, [
        "BEGIN READ ONLY;\n" +
        "SELECT current_setting('transaction_read_only');\n" +
        "SAVEPOINT mpu_sql_ro;\n" +
        "SELECT 1 AS a; SELECT 2 AS b\n" +
        ";\n" +
        "ROLLBACK TO SAVEPOINT mpu_sql_ro;\n" +
        "ROLLBACK",
      ]);
    },
  );

  await t.step("хвостовой комментарий не съедает замыкающие", async () => {
    // `SELECT 1 -- зачем-то` без перевода строки в конце: терминатор
    // стоит на своей строке, иначе комментарий проглотил бы и его, и
    // снятие метки — обход через `COMMIT` перестал бы обнаруживаться.
    const client = fakeClient(() => wrapped(ROWS));
    const session = await openPgSession(TARGET, "read-only", client.open);
    await session.run("SELECT 1 -- зачем-то");
    await session.close();
    assertEquals(client.sent[0].split("\n").slice(3), [
      "SELECT 1 -- зачем-то",
      ";",
      "ROLLBACK TO SAVEPOINT mpu_sql_ro;",
      "ROLLBACK",
    ]);
  });

  await t.step("результат — у первого оператора пользователя", async () => {
    // Смещение — константа формы обёртки: ни первый ответ (BEGIN), ни
    // последний (ROLLBACK) результатом вызова не являются.
    const other = { ...ROWS, fields: [{ name: "z" }], rows: [[9]] };
    const client = fakeClient(() => [BEGIN, READ_ONLY, MARK, ROWS, other]);
    const session = await openPgSession(TARGET, "read-only", client.open);
    assertEquals(await session.run("SELECT 1 AS a, 'x' AS b; SELECT 9 AS z"), {
      kind: "rows",
      columns: ["a", "b"],
      rows: [[1, "x"], [2, null]],
    });
    await session.close();
  });

  await t.step("служебный запрос идёт без обёртки", async () => {
    // Обёртка откатывает свою транзакцию, поэтому `SET search_path` под
    // ней не пережил бы вызова: служебный текст уходит как есть.
    const client = fakeClient(() => SET);
    const session = await openPgSession(TARGET, "read-only", client.open);
    assertEquals(
      await session.query('SET search_path TO "schema_42", public'),
      {
        kind: "done",
        rowcount: -1,
      },
    );
    await session.close();
    assertEquals(client.sent, ['SET search_path TO "schema_42", public']);
  });

  await t.step("отказ служебного запроса — ошибка БД", async () => {
    const client = fakeClient(() => serverError("boom", "42601"));
    const session = await openPgSession(TARGET, "read-only", client.open);
    const err = await assertRejects(() => session.query("SET x"));
    await session.close();
    assertInstanceOf(err, DbError);
    assertEquals(err.message, "boom");
  });

  await t.step(
    "соединение не открылось — ошибка БД, клиент закрыт",
    async () => {
      const client = fakeClient(
        () => SET,
        () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.1:5432")),
      );
      const err = await assertRejects(() =>
        openPgSession(TARGET, "read-only", client.open)
      );
      assertInstanceOf(err, DbError);
      assertEquals(err.message, "connect ECONNREFUSED 10.0.0.1:5432");
      assertEquals(client.ended(), 1);
    },
  );
});

Deno.test("отказы обёртки различаются по SQLSTATE", async (t) => {
  const run = async (reply: (text: string) => unknown) => {
    const client = fakeClient(reply);
    const session = await openPgSession(TARGET, "read-only", client.open);
    try {
      return await assertRejects(() =>
        session.run("SELECT * FROM nonexistent_table_xyz")
      );
    } finally {
      await session.close();
    }
  };

  await t.step("25006 — отказ записи своим классом", async () => {
    const err = await run(() =>
      serverError("cannot execute UPDATE in a read-only transaction", "25006")
    );
    assertInstanceOf(err, WriteRefusedError);
  });

  await t.step(
    "25P01 на снятии метки — транзакция вызова завершена",
    async () => {
      // Метку снимает замыкающий оператор обёртки: без него сервер
      // потерянной транзакции не заметит.
      const err = await run((text) =>
        text.includes("ROLLBACK TO SAVEPOINT mpu_sql_ro")
          ? serverError("no such savepoint", "25P01")
          : wrapped(ROWS)
      );
      assertInstanceOf(err, TransactionEndedError);
    },
  );

  await t.step(
    "3B001 на снятии метки — вместо транзакции вызова открыта чужая",
    async () => {
      // Второй путь того же обхода: `COMMIT; BEGIN …` не закрывает
      // транзакцию, а подменяет её, и метки в новой нет. Смысл тот же,
      // класс тот же — различение по коду, текст сервера тут другой.
      const err = await run(() =>
        serverError('savepoint "mpu_sql_ro" does not exist', "3B001")
      );
      assertInstanceOf(err, TransactionEndedError);
    },
  );

  await t.step("чужой код с тем же словом — не класс метки", async () => {
    // Слово «savepoint» в сообщении сервера ничего не решает: класс
    // отказа задаёт SQLSTATE, здесь — обычная синтаксическая ошибка.
    const err = await run(() =>
      serverError('syntax error at or near "SAVEPOINT"', "42601")
    );
    assertInstanceOf(err, DbError);
  });

  await t.step("25001 — текстом сервера, как прочие коды", async () => {
    // Одним кодом приходит и попытка снять режим, и `VACUUM` в блоке
    // транзакции: различать их не требуется.
    const err = await run(() =>
      serverError(
        "cannot set transaction read-write mode inside a read-only transaction",
        "25001",
      )
    );
    assertInstanceOf(err, DbError);
    assertEquals(
      err.message,
      "cannot set transaction read-write mode inside a read-only transaction",
    );
  });

  await t.step("позиция ошибки считается по тексту пользователя", async () => {
    // Сервер считает позицию по всему отправленному тексту; в выводе
    // обёртки быть не должно — указатель встаёт под местом ошибки.
    const err = await run((text) =>
      serverError(
        'relation "nonexistent_table_xyz" does not exist',
        "42P01",
        String(text.indexOf("nonexistent_table_xyz") + 1),
      )
    );
    assertInstanceOf(err, DbError);
    assertEquals(
      err.message,
      'relation "nonexistent_table_xyz" does not exist\n' +
        "LINE 1: SELECT * FROM nonexistent_table_xyz\n" +
        "                      ^",
    );
  });
});

Deno.test("пишущая сессия: транзакция вызова тремя обращениями", async (t) => {
  const UPDATE = { fields: [], rows: [], rowCount: 0, command: "UPDATE" };
  const TX = { fields: [], rows: [], rowCount: null, command: "BEGIN" };

  await t.step("успех: открытие, текст пользователя, фиксация", async () => {
    const client = fakeClient((text) =>
      text.startsWith("UPDATE") ? UPDATE : TX
    );
    const session = await openPgSession(TARGET, "write", client.open);
    const outcome = await session.run("UPDATE t SET a = 1 WHERE 1=0");
    await session.close();
    // Форма спеки (`sql.md`, «Инварианты»): текст пользователя уходит
    // между открытием и фиксацией и байт в байт как введён.
    assertEquals(client.sent, [
      "BEGIN",
      "UPDATE t SET a = 1 WHERE 1=0",
      "COMMIT",
    ]);
    assertEquals(outcome, { kind: "done", rowcount: 0 });
  });

  await t.step("ошибка: вместо фиксации откат", async () => {
    const client = fakeClient((text) =>
      text.startsWith("SELEC") ? serverError("syntax error", "42601", "1") : TX
    );
    const session = await openPgSession(TARGET, "write", client.open);
    const err = await assertRejects(() => session.run("SELEC 1"));
    await session.close();
    assertEquals(client.sent, ["BEGIN", "SELEC 1", "ROLLBACK"]);
    assertInstanceOf(err, DbError);
  });

  await t.step("многооператорный текст — результат первого", async () => {
    const client = fakeClient((text) =>
      text.startsWith("UPDATE") ? [UPDATE, ROWS] : TX
    );
    const session = await openPgSession(TARGET, "write", client.open);
    assertEquals(
      await session.run("UPDATE t SET a = 1; SELECT 1 AS a, 2 AS b"),
      {
        kind: "done",
        rowcount: 0,
      },
    );
    await session.close();
  });

  await t.step("отказ отката не подменяет исходную ошибку", async () => {
    const client = fakeClient((text) => {
      if (text === "ROLLBACK") return new Error("connection terminated");
      return text.startsWith("SELEC")
        ? serverError("syntax error", "42601", "1")
        : TX;
    });
    const session = await openPgSession(TARGET, "write", client.open);
    const err = await assertRejects(() => session.run("SELEC 1"));
    await session.close();
    assertInstanceOf(err, DbError);
    assertEquals(err.message, "syntax error\nLINE 1: SELEC 1\n        ^");
  });

  await t.step("отказ фиксации: своего отката за ним нет", async () => {
    // Провалившийся `COMMIT` сервер откатывает сам; лишний `ROLLBACK`
    // ушёл бы уже в закрытую транзакцию.
    const client = fakeClient((text) =>
      text === "COMMIT"
        ? serverError("deferred constraint violated", "23505")
        : text.startsWith("INSERT")
        ? UPDATE
        : TX
    );
    const session = await openPgSession(TARGET, "write", client.open);
    const err = await assertRejects(() =>
      session.run("INSERT INTO t VALUES 1")
    );
    await session.close();
    assertEquals(client.sent, ["BEGIN", "INSERT INTO t VALUES 1", "COMMIT"]);
    assertInstanceOf(err, DbError);
    assertEquals(err.message, "deferred constraint violated");
  });

  await t.step("отказ открытия транзакции — ошибка БД", async () => {
    const client = fakeClient((text) =>
      text === "BEGIN" ? serverError("terminating connection", "57P01") : TX
    );
    const session = await openPgSession(TARGET, "write", client.open);
    const err = await assertRejects(() => session.run("UPDATE t SET a = 1"));
    await session.close();
    assertEquals(client.sent, ["BEGIN"]);
    assertInstanceOf(err, DbError);
  });
});

Deno.test("пишущая сессия: опции и классы отказов", async (t) => {
  const target = {
    host: "10.0.0.1",
    port: 6432,
    database: "wb",
    username: "u",
    password: "p",
  };

  await t.step("опций стартового пакета у пишущей сессии нет", () => {
    // Спека даёт пишущей сессии ровно одно отличие в подключении:
    // опции `default_transaction_read_only=on` в стартовом пакете нет.
    assertEquals(clientOptions(target, "write").options, "");
    assertEquals(
      clientOptions(target, "read-only").options,
      "-c default_transaction_read_only=on",
    );
  });

  await t.step("SQLSTATE только-чтения — текст сервера, не подсказка", () => {
    // На пишущей сессии этот код приходит от сервера-реплики; текст
    // «используйте `mpu sql`» там был бы советом самому себе.
    const err = dbError(
      serverError("cannot execute UPDATE in a read-only transaction", "25006"),
      "UPDATE t SET a = 1",
      { mode: "write" },
    );
    assertInstanceOf(err, DbError);
    assertEquals(
      err.message,
      "cannot execute UPDATE in a read-only transaction",
    );
  });
});
