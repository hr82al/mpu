/**
 * Разбор ответов драйвера и его ошибок (`pg.ts`) — без сети: формы
 * ответа и объекты ошибок строятся литералами. Живого PostgreSQL у
 * тестов нет (`docs/specs/sql-ro.md`, «Golden-примеры»), а именно эти
 * функции переводят его ответ в наблюдаемое поведение команды.
 */

import { assertEquals, assertInstanceOf } from "@std/assert";
import driver from "pg";
import {
  clientOptions,
  dbError,
  outcomeOf,
  serverText,
  toValue,
} from "./pg.ts";
import { DbError, WriteRefusedError } from "./session.ts";

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

  await t.step("несколько операторов — массив, берётся первый", () => {
    // `SELECT 1 AS a; SELECT 2 AS b` — печатается результат первого
    // оператора (спека, «Ввод/вывод»).
    assertEquals(outcomeOf([ROWS, SET]), {
      kind: "rows",
      columns: ["a", "b"],
      rows: [[1, "x"], [2, null]],
    });
    assertEquals(outcomeOf([SET, ROWS]), { kind: "done", rowcount: -1 });
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
    const err = dbError(new Error("connect ECONNREFUSED 127.0.0.1:5432"), "");
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
  const options = clientOptions(target);

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
