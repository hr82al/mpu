/**
 * `mpu sheet set` (`docs/specs/sheet-set.md`): три режима записи.
 *
 * Кэш-БД настоящая, webapp подставной с записью всех запросов: у этой
 * команды наблюдаемо не только то, что она напечатала, но и то, что
 * ушло на сервер — сколько запросов, с каким `valueInputOption` и с
 * какими диапазонами.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
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
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    await body(db);
  } finally {
    await Deno.remove(dir, { recursive: true });
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
        valueRanges: [{
          range: "Лист!B:B",
          values: Array.from({ length: rows }, (_, at) => [`строка ${at}`]),
        }],
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

Deno.test("одна ячейка: формулой и как есть — разные valueInputOption", async (t) => {
  await t.step("умолчание — ввод пользователя", async () => {
    await withDb(async (db) => {
      const { io, sent, options } = harness(db);
      await runSet(
        args({ range: "Лист!A1", value: "=SUM(B:B)", spreadsheet: SS }),
        io,
        options,
      );
      assertEquals(sent.length, 1);
      assertEquals(sent[0].requestBody?.valueInputOption, "USER_ENTERED");
      assertEquals(sent[0].requestBody?.data, [{
        range: "Лист!A1",
        values: [["=SUM(B:B)"]],
      }]);
    });
  });

  await t.step("--literal пишет дословно", async () => {
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
      assertEquals(sent[0].requestBody?.valueInputOption, "RAW");
    });
  });
});

Deno.test("форма вывода не зависит от числа запросов", async (t) => {
  const shape = (text: string) => {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return Object.keys(parsed).sort();
  };

  await t.step("один запрос", async () => {
    await withDb(async (db) => {
      const { io, options } = harness(db);
      const result = await runSet(
        args({ range: "Лист!A1", value: "x", spreadsheet: SS }),
        io,
        options,
      );
      const text = sheetSetCommand.renderResult(result, []);
      assertEquals(shape(text), [
        "groups",
        "spreadsheetId",
        "updatedCells",
        "updatedRanges",
      ]);
      // Массив групп есть и при одном запросе: потребитель вывода не
      // должен разбирать, смешал ли оператор типы (инвариант 2).
      assertEquals(result.groups.length, 1);
    });
  });

  await t.step("два запроса — та же форма", async () => {
    await withDb(async (db) => {
      const json = JSON.stringify([
        { range: "Лист!A1", formula: "=1+1" },
        { range: "Лист!A2", value: "текст" },
      ]);
      const { io, sent, options } = harness(db, () => updated(1), json, false);
      const result = await runSet(args({ range: SS }), io, options);
      assertEquals(sent.length, 2);
      const text = sheetSetCommand.renderResult(result, []);
      assertEquals(shape(text), [
        "groups",
        "spreadsheetId",
        "updatedCells",
        "updatedRanges",
      ]);
      assertEquals(result.groups.length, 2);
      // Порядок групп фиксирован, а не взят из порядка ввода.
      assertEquals(result.groups.map((group) => group.valueInputOption), [
        "USER_ENTERED",
        "RAW",
      ]);
    });
  });
});

Deno.test("число записанных ячеек берётся из ответа сервера", async () => {
  await withDb(async (db) => {
    // Подали одну запись, сервер ответил сорока ячейками — так бывает
    // при раскрытии заливки. В выводе обязано быть сорок (инвариант 3).
    const { io, options } = harness(db, () => updated(40, 1));
    const result = await runSet(
      args({ range: "Лист!A1", value: "x", spreadsheet: SS }),
      io,
      options,
    );
    assertEquals(result.updatedCells, 40);
    assertStringIncludes(sheetSetCommand.renderResult(result, []), "40");
  });
});

Deno.test("отказ второго запроса называет записанное первым", async () => {
  await withDb(async (db) => {
    const json = JSON.stringify([
      { range: "Лист!A1", formula: "=1+1" },
      { range: "Лист!A2", value: "текст" },
    ]);
    const { io, sent, options } = harness(
      db,
      (_sent, at) =>
        at === 0
          // 400, а не 500: пятисотый канал повторяет с паузами, и
          // проверка простояла бы их все, ничего сверх не проверив.
          ? updated(7)
          : { status: 400, text: "сервер отказал" },
      json,
      false,
    );
    const err = await assertRejects(
      () => runSet(args({ range: SS }), io, options),
      DomainError,
    );
    // Молчаливый код 1 после частичной записи запрещён: сообщение
    // называет и что записано, и что нет (инвариант 1).
    assertStringIncludes(err.message, "записано частично");
    assertStringIncludes(err.message, "USER_ENTERED (7 ячеек)");
    assertStringIncludes(err.message, "RAW не записаны");
    assertEquals(sent.length > 1, true);
  });
});

Deno.test("неразбираемый диапазон — отказ до записи", async () => {
  await withDb(async (db) => {
    const { io, sent, options } = harness(db);
    await assertRejects(
      () =>
        runSet(
          args({ range: "Лист!A1:", value: "x", spreadsheet: SS }),
          io,
          options,
        ),
      UsageError,
    );
    // Ни одного обращения к серверу: пропустив такой диапазон, мы
    // записали бы значение и оставили кэш вкладки старым (инвариант 4).
    assertEquals(sent, []);
  });
});

Deno.test("пакет из файла: комментарии, пустые и строка без табуляции", async (t) => {
  const text = "# заголовок\n\nЛист!A1\t1\nЛист!A2\t2\n";

  await t.step("данные записаны, пометки пропущены", async () => {
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
      assertEquals(sent.length, 1);
      assertEquals(sent[0].requestBody?.data?.map((entry) => entry.range), [
        "Лист!A1",
        "Лист!A2",
      ]);
    });
  });

  await t.step("строка без табуляции — отказ с её номером", async () => {
    await withDb(async (db) => {
      const { io, sent, options } = harness(db);
      const withFile = makeFakeIo({
        ...io,
        readTextFile: () => Promise.resolve("Лист!A1\t1\nбез табуляции\n"),
      });
      const err = await assertRejects(
        () =>
          runSet(
            args({ from: "пакет.tsv", spreadsheet: SS }),
            withFile,
            options,
          ),
        UsageError,
      );
      assertStringIncludes(err.message, "строка 2");
      assertEquals(sent, []);
    });
  });
});

Deno.test("--literal не влияет на JSON-режим", async () => {
  await withDb(async (db) => {
    const json = JSON.stringify([{ range: "Лист!A1", formula: "=1+1" }]);
    const { io, sent, options } = harness(db, () => updated(1), json, false);
    // Тип задаёт имя свойства, а не флаг: с `--literal` формула всё
    // равно уходит как ввод пользователя (спека, «Ввод/вывод»).
    await runSet(args({ range: SS, literal: true }), io, options);
    assertEquals(sent[0].requestBody?.valueInputOption, "USER_ENTERED");
  });
});

Deno.test("открытый столбец заливается до последней занятой строки", async () => {
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
    assertEquals(sent[0].action, "spreadsheets/values/batchGet");
    // Имя листа при пересборке берётся в кавычки: `quoteTab` кавычит
    // всё, что не ASCII-имя, — общее правило семейства.
    assertEquals(sent[0].ranges, ["'Лист'!B:B"]);
    const data = sent[1].requestBody?.data;
    assertEquals(data?.[0].range, "'Лист'!B2:B5");
    assertEquals(data?.[0].values.length, 4);
  });
});

Deno.test("пустой столбец не заливается на весь лист", async () => {
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
    assertEquals(sent[1].requestBody?.data?.[0].range, "'Лист'!B2:B2");
  });
});

Deno.test("после записи вкладка инвалидируется", async () => {
  await withDb(async (db) => {
    await writeTab(db, SS, "Лист", {
      values: [["старое"]],
      formulas: [[""]],
      dims: { rows: 1, cols: 1 },
    }, 1_700_000_000);
    db.execute(
      "INSERT INTO cache (key, value, created_at, expires_at)" +
        " VALUES (?, '[]', ?, ?)",
      infoKey(SS),
      1_700_000_000,
      1_900_000_000,
    );
    assertEquals(tabsOf(db, SS), 1);
    const { io, options } = harness(db);
    await runSet(
      args({ range: "Лист!A1", value: "новое", spreadsheet: SS }),
      io,
      options,
    );
    // Следующее чтение обязано пойти к серверу: иначе оно отдаст то,
    // что мы только что перезаписали.
    assertEquals(tabsOf(db, SS), 0);
    assertEquals(
      db.query("SELECT key FROM cache WHERE key = ?", infoKey(SS)).length,
      0,
    );
  });
});

Deno.test("цель, названная дважды, — ошибка ввода", async () => {
  await withDb(async (db) => {
    const json = JSON.stringify([{ range: "Лист!A1", value: "x" }]);
    const { io, sent, options } = harness(db, () => updated(1), json, false);
    const err = await assertRejects(
      () => runSet(args({ range: SS, spreadsheet: SS }), io, options),
      UsageError,
    );
    assertStringIncludes(err.message, "дважды");
    assertEquals(sent, []);
  });
});

Deno.test("ни одного режима — отказ с образцом употребления", async () => {
  await withDb(async (db) => {
    const { io, sent, options } = harness(db);
    const err = await assertRejects(
      () => runSet(args({ spreadsheet: SS }), io, options),
      UsageError,
    );
    assertStringIncludes(err.message, "mpu sheet set --from");
    assertEquals(sent, []);
  });
});
