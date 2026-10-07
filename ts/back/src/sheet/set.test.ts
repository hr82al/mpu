/**
 * `mpu sheet set` (`docs/specs/sheet-set.md`): три режима записи.
 *
 * Кэш-БД настоящая, webapp подставной с записью всех запросов: у этой
 * команды наблюдаемо не только то, что она напечатала, но и то, что
 * ушло на сервер — сколько запросов, с каким `valueInputOption` и с
 * какими диапазонами.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rejected } from "../testing/thrown.ts";
import {
  type CacheDb,
  DomainError,
  NotFoundIoError,
  UsageError,
} from "../command/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { infoKey, writeTab } from "./cache.ts";
import { runSet, sheetSetCommand } from "./cmd_set.ts";

const SS = "1SyntheticSpreadsheetIdForGoldens0000000000";

/** Кэш-БД во временном каталоге; таблицы созданы bootstrap'ом. */
async function withDb(body: (db: CacheDb) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    await body(db);
  } finally {
    await rm(dir, { recursive: true });
  }
}

/** Разобранное тело запроса к webapp. */
interface Sent {
  readonly action: string;
  readonly requestBody?: {
    readonly valueInputOption?: string;
    readonly data?: readonly { range: string; values: unknown[][] }[];
  };
  readonly ranges?: readonly string[];
}

/** Ответ записи: столько ячеек, сколько сказал сервер, а не мы. */
function updated(cells: number, ranges = 1) {
  return {
    status: 200,
    text: JSON.stringify({
      success: true,
      result: {
        totalUpdatedCells: cells,
        responses: Array.from({ length: ranges }, () => ({})),
      },
    }),
  };
}

/** Ответ чтения столбца: `rows` занятых строк подряд. */
function column(rows: number) {
  return {
    status: 200,
    text: JSON.stringify({
      success: true,
      result: {
        valueRanges: [
          {
            range: "Лист!B:B",
            values: Array.from({ length: rows }, (_, at) => [`строка ${at}`]),
          },
        ],
      },
    }),
  };
}

/** Окружение вызова: кэш-БД, адрес webapp и подставной канал. */
function harness(
  db: CacheDb,
  reply: (sent: Sent, at: number) => { status: number; text: string } = () =>
    updated(1),
  stdin = "",
  stdinIsTerminal = true,
) {
  const sent: Sent[] = [];
  const post = (_url: string, body: string) => {
    const parsed = JSON.parse(body) as Sent;
    sent.push(parsed);
    return Promise.resolve(reply(parsed, sent.length - 1));
  };
  const io = makeFakeIo({
    envFile: {
      get: (name: string) =>
        name === "WB_PLUS_WEB_APP_URL"
          ? "https://script.example/exec"
          : undefined,
      require: () => "https://script.example/exec",
      set: () => Promise.reject(new Error("запись env-файла не ожидается")),
      values: () => ({}),
    },
    openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }),
    readTextFile: (path: string) => {
      throw new NotFoundIoError(`нет файла ${path}`);
    },
    readStdin: () => Promise.resolve(new TextEncoder().encode(stdin)),
    stdinIsTerminal: () => stdinIsTerminal,
    note: () => {},
  });
  return { io, sent, options: { post, nowSeconds: 1_700_000_000 } };
}

const args = (over: Record<string, unknown> = {}) =>
  ({
    literal: false,
    ...over,
  }) as Parameters<typeof runSet>[0];

const tabsOf = (db: CacheDb, ssId: string) =>
  db.query("SELECT tab_name FROM sheet_tabs WHERE ss_id = ?", ssId).length;

describe("одна ячейка: формулой и как есть — разные valueInputOption", () => {
  it("умолчание — ввод пользователя", async () => {
    await withDb(async (db) => {
      const { io, sent, options } = harness(db);
      await runSet(
        args({ range: "Лист!A1", value: "=SUM(B:B)", spreadsheet: SS }),
        io,
        options,
      );
      expect(sent.length).toBe(1);
      expect(sent[0].requestBody?.valueInputOption).toBe("USER_ENTERED");
      expect(sent[0].requestBody?.data).toStrictEqual([
        {
          range: "Лист!A1",
          values: [["=SUM(B:B)"]],
        },
      ]);
    });
  });

  it("--literal пишет дословно", async () => {
    await withDb(async (db) => {
      const { io, sent, options } = harness(db);
      await runSet(
        args({
          range: "Лист!A1",
          value: "=SUM(B:B)",
          spreadsheet: SS,
          literal: true,
        }),
        io,
        options,
      );
      expect(sent[0].requestBody?.valueInputOption).toBe("RAW");
    });
  });
});

describe("форма вывода не зависит от числа запросов", () => {
  const shape = (text: string) => {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return Object.keys(parsed).sort();
  };

  it("один запрос", async () => {
    await withDb(async (db) => {
      const { io, options } = harness(db);
      const result = await runSet(
        args({ range: "Лист!A1", value: "x", spreadsheet: SS }),
        io,
        options,
      );
      const text = sheetSetCommand.renderResult(result, []);
      expect(shape(text)).toStrictEqual([
        "groups",
        "spreadsheetId",
        "updatedCells",
        "updatedRanges",
      ]);
      // Массив групп есть и при одном запросе: потребитель вывода не
      // должен разбирать, смешал ли оператор типы (инвариант 2).
      expect(result.groups.length).toBe(1);
    });
  });

  it("два запроса — та же форма", async () => {
    await withDb(async (db) => {
      const json = JSON.stringify([
        { range: "Лист!A1", formula: "=1+1" },
        { range: "Лист!A2", value: "текст" },
      ]);
      const { io, sent, options } = harness(db, () => updated(1), json, false);
      const result = await runSet(args({ range: SS }), io, options);
      expect(sent.length).toBe(2);
      const text = sheetSetCommand.renderResult(result, []);
      expect(shape(text)).toStrictEqual([
        "groups",
        "spreadsheetId",
        "updatedCells",
        "updatedRanges",
      ]);
      expect(result.groups.length).toBe(2);
      // Порядок групп фиксирован, а не взят из порядка ввода.
      expect(
        result.groups.map((group) => group.valueInputOption),
      ).toStrictEqual(["USER_ENTERED", "RAW"]);
    });
  });
});

it("число записанных ячеек берётся из ответа сервера", async () => {
  await withDb(async (db) => {
    // Подали одну запись, сервер ответил сорока ячейками — так бывает
    // при раскрытии заливки. В выводе обязано быть сорок (инвариант 3).
    const { io, options } = harness(db, () => updated(40, 1));
    const result = await runSet(
      args({ range: "Лист!A1", value: "x", spreadsheet: SS }),
      io,
      options,
    );
    expect(result.updatedCells).toBe(40);
    expect(sheetSetCommand.renderResult(result, [])).toContain("40");
  });
});

it("отказ второго запроса называет записанное первым", async () => {
  await withDb(async (db) => {
    const json = JSON.stringify([
      { range: "Лист!A1", formula: "=1+1" },
      { range: "Лист!A2", value: "текст" },
    ]);
    const { io, sent, options } = harness(
      db,
      (_sent, at) =>
        at === 0
          ? // 400, а не 500: пятисотый канал повторяет с паузами, и
            // проверка простояла бы их все, ничего сверх не проверив.
            updated(7)
          : { status: 400, text: "сервер отказал" },
      json,
      false,
    );
    const err = await rejected(
      () => runSet(args({ range: SS }), io, options),
      DomainError,
    );
    // Молчаливый код 1 после частичной записи запрещён: сообщение
    // называет и что записано, и что нет (инвариант 1).
    expect(err.message).toContain("записано частично");
    expect(err.message).toContain("USER_ENTERED уже записаны (7 ячеек)");
    expect(err.message).toContain("RAW не записаны");
    expect(sent.length > 1).toBe(true);
  });
});

it("неразбираемый диапазон — отказ до записи", async () => {
  await withDb(async (db) => {
    const { io, sent, options } = harness(db);
    await expect(
      runSet(
        args({ range: "Лист!A1:", value: "x", spreadsheet: SS }),
        io,
        options,
      ),
    ).rejects.toThrow(UsageError);
    // Ни одного обращения к серверу: пропустив такой диапазон, мы
    // записали бы значение и оставили кэш вкладки старым (инвариант 4).
    expect(sent).toStrictEqual([]);
  });
});

describe("пакет из файла: комментарии, пустые и строка без табуляции", () => {
  const text = "# заголовок\n\nЛист!A1\t1\nЛист!A2\t2\n";

  it("данные записаны, пометки пропущены", async () => {
    await withDb(async (db) => {
      const { io, sent, options } = harness(db);
      const withFile = makeFakeIo({
        ...io,
        readTextFile: () => Promise.resolve(text),
      });
      await runSet(
        args({ from: "пакет.tsv", spreadsheet: SS }),
        withFile,
        options,
      );
      expect(sent.length).toBe(1);
      expect(
        sent[0].requestBody?.data?.map((entry) => entry.range),
      ).toStrictEqual(["Лист!A1", "Лист!A2"]);
    });
  });

  it("строка без табуляции — отказ с её номером", async () => {
    await withDb(async (db) => {
      const { io, sent, options } = harness(db);
      const withFile = makeFakeIo({
        ...io,
        readTextFile: () => Promise.resolve("Лист!A1\t1\nбез табуляции\n"),
      });
      const err = await rejected(
        () =>
          runSet(
            args({ from: "пакет.tsv", spreadsheet: SS }),
            withFile,
            options,
          ),
        UsageError,
      );
      expect(err.message).toContain("строка 2");
      expect(sent).toStrictEqual([]);
    });
  });
});

it("--literal не влияет на JSON-режим", async () => {
  await withDb(async (db) => {
    const json = JSON.stringify([{ range: "Лист!A1", formula: "=1+1" }]);
    const { io, sent, options } = harness(db, () => updated(1), json, false);
    // Тип задаёт имя свойства, а не флаг: с `--literal` формула всё
    // равно уходит как ввод пользователя (спека, «Ввод/вывод»).
    await runSet(args({ range: SS, literal: true }), io, options);
    expect(sent[0].requestBody?.valueInputOption).toBe("USER_ENTERED");
  });
});

it("открытый столбец заливается до последней занятой строки", async () => {
  await withDb(async (db) => {
    const json = JSON.stringify([{ range: "Лист!B2:B", value: "x" }]);
    // Лист на тысячу строк, занято пять: заливка обязана дойти до
    // пятой, а не до конца листа.
    const { io, sent, options } = harness(
      db,
      (sentBody) =>
        sentBody.action === "spreadsheets/values/batchGet"
          ? column(5)
          : updated(4),
      json,
      false,
    );
    await runSet(args({ range: SS }), io, options);
    // Первый запрос — то самое лишнее чтение столбца, ради которого
    // режим и стоит дороже прочих.
    expect(sent[0].action).toBe("spreadsheets/values/batchGet");
    // Имя листа при пересборке берётся в кавычки: `quoteTab` кавычит
    // всё, что не ASCII-имя, — общее правило семейства.
    expect(sent[0].ranges).toStrictEqual(["'Лист'!B:B"]);
    const data = sent[1].requestBody?.data;
    expect(data?.[0].range).toBe("'Лист'!B2:B5");
    expect(data?.[0].values.length).toBe(4);
  });
});

it("пустой столбец не заливается на весь лист", async () => {
  await withDb(async (db) => {
    const json = JSON.stringify([{ range: "Лист!B2:B", value: "x" }]);
    const { io, sent, options } = harness(
      db,
      (sentBody) =>
        sentBody.action === "spreadsheets/values/batchGet"
          ? column(0)
          : updated(1),
      json,
      false,
    );
    await runSet(args({ range: SS }), io, options);
    // Ниже последней занятой строки заливать нечего — остаётся одна
    // ячейка, та самая, с которой начали.
    expect(sent[1].requestBody?.data?.[0].range).toBe("'Лист'!B2:B2");
  });
});

it("после записи вкладка инвалидируется", async () => {
  await withDb(async (db) => {
    await writeTab(
      db,
      SS,
      "Лист",
      {
        values: [["старое"]],
        formulas: [[""]],
        dims: { rows: 1, cols: 1 },
      },
      1_700_000_000,
    );
    db.execute(
      "INSERT INTO cache (key, value, created_at, expires_at)" +
        " VALUES (?, '[]', ?, ?)",
      infoKey(SS),
      1_700_000_000,
      1_900_000_000,
    );
    expect(tabsOf(db, SS)).toBe(1);
    const { io, options } = harness(db);
    await runSet(
      args({ range: "Лист!A1", value: "новое", spreadsheet: SS }),
      io,
      options,
    );
    // Следующее чтение обязано пойти к серверу: иначе оно отдаст то,
    // что мы только что перезаписали.
    expect(tabsOf(db, SS)).toBe(0);
    expect(
      db.query("SELECT key FROM cache WHERE key = ?", infoKey(SS)).length,
    ).toBe(0);
  });
});

it("цель, названная дважды, — ошибка ввода", async () => {
  await withDb(async (db) => {
    const json = JSON.stringify([{ range: "Лист!A1", value: "x" }]);
    const { io, sent, options } = harness(db, () => updated(1), json, false);
    const err = await rejected(
      () => runSet(args({ range: SS, spreadsheet: SS }), io, options),
      UsageError,
    );
    expect(err.message).toContain("дважды");
    expect(sent).toStrictEqual([]);
  });
});

it("ни одного режима — отказ с образцом употребления", async () => {
  await withDb(async (db) => {
    const { io, sent, options } = harness(db);
    const err = await rejected(
      () => runSet(args({ spreadsheet: SS }), io, options),
      UsageError,
    );
    expect(err.message).toContain("mpu sheet set --from");
    expect(sent).toStrictEqual([]);
  });
});

/** Ответ посредника на запись: одна строка успеха, без величин. */
function bare() {
  return {
    status: 200,
    text: JSON.stringify({
      success: true,
      result: { value: "data batchUpdate succesfull" },
    }),
  };
}

describe("сервер величин не сообщил — их нет ни в выводе, ни нулём", () => {
  it("структурный результат: null, а не 0", async () => {
    await withDb(async (db) => {
      const { io, options } = harness(db, () => bare());
      const result = await runSet(
        args({ range: "Лист!A1", value: "x", spreadsheet: SS }),
        io,
        options,
      );
      // `null` переживает сериализацию и читается как «нет данных»;
      // ноль читался бы как «записано ноль» — другой исход.
      expect(result.updatedCells).toStrictEqual(null);
      expect(result.updatedRanges).toStrictEqual(null);
      expect(result.groups[0].updatedCells).toStrictEqual(null);
      expect(result.groups[0].updatedRanges).toStrictEqual(null);
    });
  });

  it("в человеческом выводе величины нет вовсе", async () => {
    await withDb(async (db) => {
      const { io, options } = harness(db, () => bare());
      const result = await runSet(
        args({ range: "Лист!A1", value: "x", spreadsheet: SS }),
        io,
        options,
      );
      const printed = JSON.parse(
        sheetSetCommand.renderResult(result, []),
      ) as Record<string, unknown>;
      expect(Object.keys(printed).sort()).toStrictEqual([
        "groups",
        "spreadsheetId",
      ]);
      expect(
        Object.keys((printed.groups as Record<string, unknown>[])[0]),
      ).toStrictEqual(["valueInputOption"]);
    });
  });

  it("частичный успех не говорит «0 ячеек»", async () => {
    await withDb(async (db) => {
      const json = JSON.stringify([
        { range: "Лист!A1", formula: "=1+1" },
        { range: "Лист!A2", value: "текст" },
      ]);
      const { io, options } = harness(
        db,
        (_sent, at) =>
          at === 0 ? bare() : { status: 400, text: "сервер отказал" },
        json,
        false,
      );
      const err = await rejected(
        () => runSet(args({ range: SS }), io, options),
        DomainError,
      );
      // В самый неудачный момент оператор обязан прочесть «записаны»,
      // а не «ноль»: первое — правда, второе — противоположность.
      expect(err.message).toContain(
        "USER_ENTERED уже записаны (сколько — сервер не сообщил)",
      );
      expect(err.message.includes("0 ячеек")).toBe(false);
    });
  });
});

it("итог не складывает известное с неизвестным", async () => {
  await withDb(async (db) => {
    const json = JSON.stringify([
      { range: "Лист!A1", formula: "=1+1" },
      { range: "Лист!A2", value: "текст" },
    ]);
    // Первая группа величину получила, вторая — нет. Итог тогда не
    // итог, а нижняя граница, выданная за итог.
    const { io, options } = harness(
      db,
      (_sent, at) => (at === 0 ? updated(3) : bare()),
      json,
      false,
    );
    const result = await runSet(args({ range: SS }), io, options);
    expect(result.groups[0].updatedCells).toBe(3);
    expect(result.groups[1].updatedCells).toStrictEqual(null);
    expect(result.updatedCells).toStrictEqual(null);
  });
});

it("spreadsheetId — из резолва, а не эхо сервера", async () => {
  await withDb(async (db) => {
    // В ответе записи идентификатора нет вовсе: поле говорит, куда мы
    // писали, а не куда, по словам сервера, записалось.
    const { io, options } = harness(db, () => bare());
    const result = await runSet(
      args({ range: "Лист!A1", value: "x", spreadsheet: SS }),
      io,
      options,
    );
    expect(result.spreadsheetId).toStrictEqual(SS);
  });
});
