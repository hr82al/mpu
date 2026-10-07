/**
 * Разбор ответов драйвера и его ошибок (`pg.ts`) — без сети: формы
 * ответа и объекты ошибок строятся литералами. Живого PostgreSQL у
 * тестов нет (`docs/specs/sql-ro.md`, «Golden-примеры»), а именно эти
 * функции переводят его ответ в наблюдаемое поведение команды.
 */

import { assert, describe, expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
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
  StatementError,
  TransactionEndedError,
  WriteRefusedError,
} from "./session.ts";

/** Ошибка сервера как её отдаёт драйвер: SQLSTATE и позиция строками. */
function serverError(message: string, code: string, position?: string): Error {
  const err = new driver.DatabaseError(message, message.length, "error");
  Object.assign(err, { code, position });
  return err;
}

// Поле ответа драйвера несёт и тип колонки (`dataTypeID`): 23 —
// int4, 25 — text. Он нужен переносу строк (`src/copy/rows.ts`), и
// фикстура обязана быть такой же, как настоящий ответ.
const ROWS = {
  fields: [
    { name: "a", dataTypeID: 23 },
    { name: "b", dataTypeID: 25 },
  ],
  rows: [
    [1, "x"],
    [2, null],
  ],
  rowCount: 2,
  command: "SELECT",
};

const SET = { fields: [], rows: [], rowCount: null, command: "SET" };

describe("форма ответа зависит от числа операторов", () => {
  it("один оператор — объект результата", () => {
    expect(outcomeOf(ROWS)).toStrictEqual({
      kind: "rows",
      columns: ["a", "b"],
      oids: [23, 25],
      rows: [
        [1, "x"],
        [2, null],
      ],
    });
  });

  it("несколько операторов — массив, берётся названный", () => {
    // Ответ на текст в обёртке: результат пользовательского оператора
    // лежит под своим номером, соседи в счёт не идут.
    expect(outcomeAt([SET, ROWS], 1)).toStrictEqual({
      kind: "rows",
      columns: ["a", "b"],
      oids: [23, 25],
      rows: [
        [1, "x"],
        [2, null],
      ],
    });
    expect(outcomeAt([ROWS, SET], 1)).toStrictEqual({
      kind: "done",
      rowcount: -1,
    });
  });

  it("оператора под номером нет — как оператор без строк", () => {
    // Текст из одного комментария операторов не даёт: печатается
    // `OK (rowcount=-1)`, а не отказ.
    expect(outcomeAt([SET], 3)).toStrictEqual({ kind: "done", rowcount: -1 });
  });

  it("оператор без набора строк: rowCount null — это -1", () => {
    expect(outcomeOf(SET)).toStrictEqual({ kind: "done", rowcount: -1 });
    expect(outcomeOf({ ...SET, rowCount: 0 })).toStrictEqual({
      kind: "done",
      rowcount: 0,
    });
  });

  it("выборка без строк остаётся набором строк", () => {
    expect(outcomeOf({ ...ROWS, rows: [], rowCount: 0 })).toStrictEqual({
      kind: "rows",
      columns: ["a", "b"],
      oids: [23, 25],
      rows: [],
    });
  });
});

describe("значение ячейки: JSON-представимое как есть, прочее текстом", () => {
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
    it(title, () => {
      expect(toValue(value)).toStrictEqual(expected);
    });
  }
});

describe("ошибки драйвера в классы порта", () => {
  it("SQLSTATE 25006 — отказ записи, различается по коду", () => {
    const err = dbError(
      serverError("cannot execute UPDATE in a read-only transaction", "25006"),
      "UPDATE t SET a = 1",
      { mode: "read-only" },
    );
    assert(err instanceof WriteRefusedError);
  });

  it("прочий SQLSTATE — текст сервера с позицией", () => {
    const err = dbError(
      serverError(
        'relation "nonexistent_table_xyz" does not exist',
        "42P01",
        "15",
      ),
      "SELECT * FROM nonexistent_table_xyz",
      { mode: "read-only" },
    );
    assert(err instanceof DbError);
    expect(err.message).toStrictEqual(
      'relation "nonexistent_table_xyz" does not exist\n' +
        "LINE 1: SELECT * FROM nonexistent_table_xyz\n" +
        "                      ^",
    );
  });

  it("сбой соединения — та же ошибка БД", () => {
    const err = dbError(new Error("connect ECONNREFUSED 127.0.0.1:5432"), "", {
      mode: "read-only",
    });
    assert(err instanceof DbError);
    expect(err.message).toBe("connect ECONNREFUSED 127.0.0.1:5432");
  });
});

describe("указатель на место ошибки", () => {
  it("позиция во второй строке считается от её начала", () => {
    // Позиция 15 — первый символ `nosuch`; префикс `LINE 2: ` — 8
    // символов, начало строки — 10-й символ запроса.
    expect(serverText("boom", "SELECT 1\nFROM nosuch", "15")).toStrictEqual(
      `boom\nLINE 2: FROM nosuch\n${" ".repeat(13)}^`,
    );
  });

  it("позиции нет — только сообщение сервера", () => {
    expect(serverText("boom", "SELECT 1", undefined)).toBe("boom");
  });

  it("позиция вне текста запроса игнорируется", () => {
    expect(serverText("boom", "SELECT 1", "999")).toBe("boom");
    expect(serverText("boom", "SELECT 1", "0")).toBe("boom");
    expect(serverText("boom", "SELECT 1", "не число")).toBe("boom");
  });

  it("позиция считается в символах, а не в байтах", () => {
    // Кириллическая буква — два байта и один символ: указатель обязан
    // встать под `nosuch`, то есть под 17-м символом.
    expect(serverText("boom", "SELECT 'ы' FROM nosuch", "17")).toStrictEqual(
      `boom\nLINE 1: SELECT 'ы' FROM nosuch\n${" ".repeat(24)}^`,
    );
  });
});

describe("опции подключения: read-only и независимость от окружения", () => {
  const target = {
    host: "10.0.0.1",
    port: 6432,
    database: "wb",
    username: "u",
    password: "p",
  };
  const options = clientOptions(target, "read-only");

  it("сессия открывается read-only опцией стартового пакета", () => {
    // Единственный механизм запрета записи (`platform/readonly-default.md`):
    // сервер получает его в стартовом пакете, до всякого SQL.
    expect(options.options).toBe("-c default_transaction_read_only=on");
  });

  it("адрес и креды — из аргумента, а не из окружения", () => {
    expect([
      options.host,
      options.port,
      options.database,
      options.user,
    ]).toStrictEqual(["10.0.0.1", 6432, "wb", "u"]);
  });

  it("прочие опции заданы явно: окружение их не решает", () => {
    // Не переданную опцию драйвер ищет в `PG*` процесса — конфигурация
    // же живёт только в env-файле (`platform/env-file.md`).
    expect(options.application_name).toBe("mpu");
    expect(options.ssl).toBe(false);
    expect(options.sslnegotiation).toBe("postgres");
    expect(options.client_encoding).toBe("UTF8");
    expect(options.connectionTimeoutMillis).toBe(0);
  });

  it("дата берётся текстом сервера, число — разбором", () => {
    const parser = options.types.getTypeParser;
    // 1114 — timestamp: значение проходит насквозь.
    expect(parser(1114)("2026-08-05 12:00:00")).toBe("2026-08-05 12:00:00");
    // 23 — int4: разбирает драйвер, и это число, а не строка.
    expect(parser(23)("42")).toBe(42);
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
  const values: (readonly unknown[] | undefined)[] = [];
  let ended = 0;
  const open: OpenClient = () => ({
    connect,
    query: ({ text, values: params }) => {
      sent.push(text);
      values.push(params);
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
  return { open, sent, values, ended: () => ended };
}

/** Ответ сервера на успешно исполненную обёртку с одним оператором. */
function wrapped(user: unknown): readonly unknown[] {
  return [BEGIN, READ_ONLY, MARK, user, MARK, BEGIN];
}

describe("пользовательский текст исполняется внутри обёртки", () => {
  it("обёртка собрана дословно, текст пользователя как есть", async () => {
    const client = fakeClient(() => wrapped(ROWS));
    const session = await openPgSession(TARGET, "read-only", client.open);
    await session.run("SELECT 1 AS a; SELECT 2 AS b");
    await session.close();
    // Форма — `platform/readonly-default.md`: три оператора до текста
    // пользователя и два после, метка не из его ввода.
    expect(client.sent).toStrictEqual([
      "BEGIN READ ONLY;\n" +
        "SELECT current_setting('transaction_read_only');\n" +
        "SAVEPOINT mpu_sql_ro;\n" +
        "SELECT 1 AS a; SELECT 2 AS b\n" +
        ";\n" +
        "ROLLBACK TO SAVEPOINT mpu_sql_ro;\n" +
        "ROLLBACK",
    ]);
  });

  it("хвостовой комментарий не съедает замыкающие", async () => {
    // `SELECT 1 -- зачем-то` без перевода строки в конце: терминатор
    // стоит на своей строке, иначе комментарий проглотил бы и его, и
    // снятие метки — обход через `COMMIT` перестал бы обнаруживаться.
    const client = fakeClient(() => wrapped(ROWS));
    const session = await openPgSession(TARGET, "read-only", client.open);
    await session.run("SELECT 1 -- зачем-то");
    await session.close();
    expect(client.sent[0].split("\n").slice(3)).toStrictEqual([
      "SELECT 1 -- зачем-то",
      ";",
      "ROLLBACK TO SAVEPOINT mpu_sql_ro;",
      "ROLLBACK",
    ]);
  });

  it("результат — у первого оператора пользователя", async () => {
    // Смещение — константа формы обёртки: ни первый ответ (BEGIN), ни
    // последний (ROLLBACK) результатом вызова не являются.
    const other = { ...ROWS, fields: [{ name: "z" }], rows: [[9]] };
    const client = fakeClient(() => [BEGIN, READ_ONLY, MARK, ROWS, other]);
    const session = await openPgSession(TARGET, "read-only", client.open);
    expect(
      await session.run("SELECT 1 AS a, 'x' AS b; SELECT 9 AS z"),
    ).toStrictEqual({
      kind: "rows",
      columns: ["a", "b"],
      oids: [23, 25],
      rows: [
        [1, "x"],
        [2, null],
      ],
    });
    await session.close();
  });

  it("служебный запрос идёт без обёртки", async () => {
    // Обёртка откатывает свою транзакцию, поэтому `SET search_path` под
    // ней не пережил бы вызова: служебный текст уходит как есть.
    const client = fakeClient(() => SET);
    const session = await openPgSession(TARGET, "read-only", client.open);
    expect(
      await session.query('SET search_path TO "schema_42", public'),
    ).toStrictEqual({
      kind: "done",
      rowcount: -1,
    });
    await session.close();
    expect(client.sent).toStrictEqual([
      'SET search_path TO "schema_42", public',
    ]);
  });

  it("отказ служебного запроса — ошибка БД", async () => {
    const client = fakeClient(() => serverError("boom", "42601"));
    const session = await openPgSession(TARGET, "read-only", client.open);
    const failure = session.query("SET x");
    await expect(failure).rejects.toThrow();
    const err: unknown = await failure.catch((thrown) => thrown);
    await session.close();
    assert(err instanceof DbError);
    expect(err.message).toBe("boom");
  });

  it("соединение не открылось — ошибка БД, клиент закрыт", async () => {
    const client = fakeClient(
      () => SET,
      () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.1:5432")),
    );
    const failure = openPgSession(TARGET, "read-only", client.open);
    await expect(failure).rejects.toThrow();
    const err = await rejected(() => failure, DbError);
    expect(err.message).toBe("connect ECONNREFUSED 10.0.0.1:5432");
    expect(client.ended()).toBe(1);
  });
});

describe("отказы обёртки различаются по SQLSTATE", () => {
  const run = async (reply: (text: string) => unknown) => {
    const client = fakeClient(reply);
    const session = await openPgSession(TARGET, "read-only", client.open);
    try {
      const failure = session.run("SELECT * FROM nonexistent_table_xyz");
      await expect(failure).rejects.toThrow();
      return await failure;
    } finally {
      await session.close();
    }
  };

  it("25006 — отказ записи своим классом", async () => {
    await rejected(
      () =>
        run(() =>
          serverError(
            "cannot execute UPDATE in a read-only transaction",
            "25006",
          ),
        ),
      WriteRefusedError,
    );
  });

  it("25P01 на снятии метки — транзакция вызова завершена", async () => {
    // Метку снимает замыкающий оператор обёртки: без него сервер
    // потерянной транзакции не заметит.
    await rejected(
      () =>
        run((text) =>
          text.includes("ROLLBACK TO SAVEPOINT mpu_sql_ro")
            ? serverError("no such savepoint", "25P01")
            : wrapped(ROWS),
        ),
      TransactionEndedError,
    );
  });

  it("3B001 на снятии метки — вместо транзакции вызова открыта чужая", async () => {
    // Второй путь того же обхода: `COMMIT; BEGIN …` не закрывает
    // транзакцию, а подменяет её, и метки в новой нет. Смысл тот же,
    // класс тот же — различение по коду, текст сервера тут другой.
    await rejected(
      () =>
        run(() =>
          serverError('savepoint "mpu_sql_ro" does not exist', "3B001"),
        ),
      TransactionEndedError,
    );
  });

  it("чужой код с тем же словом — не класс метки", async () => {
    // Слово «savepoint» в сообщении сервера ничего не решает: класс
    // отказа задаёт SQLSTATE, здесь — обычная синтаксическая ошибка.
    await rejected(
      () =>
        run(() => serverError('syntax error at or near "SAVEPOINT"', "42601")),
      DbError,
    );
  });

  it("25001 — текстом сервера, как прочие коды", async () => {
    // Одним кодом приходит и попытка снять режим, и `VACUUM` в блоке
    // транзакции: различать их не требуется.
    const err = await rejected(
      () =>
        run(() =>
          serverError(
            "cannot set transaction read-write mode inside a read-only transaction",
            "25001",
          ),
        ),
      DbError,
    );
    expect(err.message).toBe(
      "cannot set transaction read-write mode inside a read-only transaction",
    );
  });

  it("позиция ошибки считается по тексту пользователя", async () => {
    // Сервер считает позицию по всему отправленному тексту; в выводе
    // обёртки быть не должно — указатель встаёт под местом ошибки.
    const err = await rejected(
      () =>
        run((text) =>
          serverError(
            'relation "nonexistent_table_xyz" does not exist',
            "42P01",
            String(text.indexOf("nonexistent_table_xyz") + 1),
          ),
        ),
      DbError,
    );
    expect(err.message).toStrictEqual(
      'relation "nonexistent_table_xyz" does not exist\n' +
        "LINE 1: SELECT * FROM nonexistent_table_xyz\n" +
        "                      ^",
    );
  });
});

describe("пишущая сессия: транзакция вызова тремя обращениями", () => {
  const UPDATE = { fields: [], rows: [], rowCount: 0, command: "UPDATE" };
  const TX = { fields: [], rows: [], rowCount: null, command: "BEGIN" };

  it("успех: открытие, текст пользователя, фиксация", async () => {
    const client = fakeClient((text) =>
      text.startsWith("UPDATE") ? UPDATE : TX,
    );
    const session = await openPgSession(TARGET, "write", client.open);
    const outcome = await session.run("UPDATE t SET a = 1 WHERE 1=0");
    await session.close();
    // Форма спеки (`sql.md`, «Инварианты»): текст пользователя уходит
    // между открытием и фиксацией и байт в байт как введён.
    expect(client.sent).toStrictEqual([
      "BEGIN",
      "UPDATE t SET a = 1 WHERE 1=0",
      "COMMIT",
    ]);
    expect(outcome).toStrictEqual({ kind: "done", rowcount: 0 });
  });

  it("ошибка: вместо фиксации откат", async () => {
    const client = fakeClient((text) =>
      text.startsWith("SELEC") ? serverError("syntax error", "42601", "1") : TX,
    );
    const session = await openPgSession(TARGET, "write", client.open);
    const failure = session.run("SELEC 1");
    await expect(failure).rejects.toThrow();
    const err: unknown = await failure.catch((thrown) => thrown);
    await session.close();
    expect(client.sent).toStrictEqual(["BEGIN", "SELEC 1", "ROLLBACK"]);
    assert(err instanceof DbError);
  });

  it("многооператорный текст — результат первого", async () => {
    const client = fakeClient((text) =>
      text.startsWith("UPDATE") ? [UPDATE, ROWS] : TX,
    );
    const session = await openPgSession(TARGET, "write", client.open);
    expect(
      await session.run("UPDATE t SET a = 1; SELECT 1 AS a, 2 AS b"),
    ).toStrictEqual({
      kind: "done",
      rowcount: 0,
    });
    await session.close();
  });

  it("отказ отката не подменяет исходную ошибку", async () => {
    const client = fakeClient((text) => {
      if (text === "ROLLBACK") return new Error("connection terminated");
      return text.startsWith("SELEC")
        ? serverError("syntax error", "42601", "1")
        : TX;
    });
    const session = await openPgSession(TARGET, "write", client.open);
    const failure = session.run("SELEC 1");
    await expect(failure).rejects.toThrow();
    const err: unknown = await failure.catch((thrown) => thrown);
    await session.close();
    assert(err instanceof DbError);
    expect(err.message).toBe("syntax error\nLINE 1: SELEC 1\n        ^");
  });

  it("отказ фиксации: своего отката за ним нет", async () => {
    // Провалившийся `COMMIT` сервер откатывает сам; лишний `ROLLBACK`
    // ушёл бы уже в закрытую транзакцию.
    const client = fakeClient((text) =>
      text === "COMMIT"
        ? serverError("deferred constraint violated", "23505")
        : text.startsWith("INSERT")
          ? UPDATE
          : TX,
    );
    const session = await openPgSession(TARGET, "write", client.open);
    const failure = session.run("INSERT INTO t VALUES 1");
    await expect(failure).rejects.toThrow();
    const err: unknown = await failure.catch((thrown) => thrown);
    await session.close();
    expect(client.sent).toStrictEqual([
      "BEGIN",
      "INSERT INTO t VALUES 1",
      "COMMIT",
    ]);
    assert(err instanceof DbError);
    expect(err.message).toBe("deferred constraint violated");
  });

  it("отказ открытия транзакции — ошибка БД", async () => {
    const client = fakeClient((text) =>
      text === "BEGIN" ? serverError("terminating connection", "57P01") : TX,
    );
    const session = await openPgSession(TARGET, "write", client.open);
    const failure = session.run("UPDATE t SET a = 1");
    await expect(failure).rejects.toThrow();
    const err: unknown = await failure.catch((thrown) => thrown);
    await session.close();
    expect(client.sent).toStrictEqual(["BEGIN"]);
    assert(err instanceof DbError);
  });
});

describe("пишущая сессия: опции и классы отказов", () => {
  const target = {
    host: "10.0.0.1",
    port: 6432,
    database: "wb",
    username: "u",
    password: "p",
  };

  it("опций стартового пакета у пишущей сессии нет", () => {
    // Спека даёт пишущей сессии ровно одно отличие в подключении:
    // опции `default_transaction_read_only=on` в стартовом пакете нет.
    expect(clientOptions(target, "write").options).toBe("");
    expect(clientOptions(target, "read-only").options).toBe(
      "-c default_transaction_read_only=on",
    );
  });

  it("SQLSTATE только-чтения — текст сервера, не подсказка", () => {
    // На пишущей сессии этот код приходит от сервера-реплики; текст
    // «используйте `mpu sql`» там был бы советом самому себе.
    const err = dbError(
      serverError("cannot execute UPDATE in a read-only transaction", "25006"),
      "UPDATE t SET a = 1",
      { mode: "write" },
    );
    assert(err instanceof DbError);
    expect(err.message).toBe(
      "cannot execute UPDATE in a read-only transaction",
    );
  });
});

describe("runMany: одна транзакция на список, значения — параметрами", () => {
  const done = { fields: [], rows: [], rowCount: 1, command: "INSERT" };

  it("BEGIN, операторы по одному, COMMIT", async () => {
    const client = fakeClient(() => done);
    const session = await openPgSession(TARGET, "write", client.open);
    const outcomes = await session.runMany([
      { sql: "DELETE FROM t WHERE id = $1", params: [7], label: "t" },
      { sql: "SET session_replication_role = replica" },
    ]);
    expect(client.sent).toStrictEqual([
      "BEGIN",
      "DELETE FROM t WHERE id = $1",
      "SET session_replication_role = replica",
      "COMMIT",
    ]);
    // Значения уходят отдельно от текста: у оператора без параметров их
    // нет вовсе, и он идёт простым протоколом.
    expect(client.values).toStrictEqual([undefined, [7], undefined, undefined]);
    expect(outcomes.length).toBe(2);
    await session.close();
  });

  it("отказ оператора — ROLLBACK и номер с меткой", async () => {
    const boom = serverError("нельзя", "22P02");
    const client = fakeClient((text) =>
      text.startsWith("INSERT") ? boom : done,
    );
    const session = await openPgSession(TARGET, "write", client.open);
    const err = await rejected(
      () =>
        session.runMany([
          { sql: "DELETE FROM t", label: "t" },
          { sql: "INSERT INTO t VALUES ($1)", params: [1], label: "t" },
        ]),
      StatementError,
    );
    expect(err.index).toBe(1);
    expect(err.label).toBe("t");
    // Откат обязателен: без него соединение осталось бы в прерванной
    // транзакции, а посев — наполовину применённым в глазах вызывающего.
    expect(client.sent.at(-1)).toBe("ROLLBACK");
    await session.close();
  });
});
