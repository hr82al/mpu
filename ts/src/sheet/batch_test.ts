/**
 * Пакетные подкоманды (`docs/specs/sheet-batch.md`): формы вывода
 * против эталонов канала, порядок вызовов и инвалидация кэша.
 *
 * Живого webapp нет: канал подставной, кэш-БД настоящая — она и есть
 * то, на чём видно, инвалидировали кэш или нет.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  type CacheDb,
  DomainError,
  formatCommandError,
  NotFoundIoError,
  UsageError,
} from "../command/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { writeTab } from "./cache.ts";
import { runBatchGet } from "./cmd_batch_get.ts";
import {
  renderBatchUpdate,
  runBatchUpdate,
  sheetBatchUpdateCommand,
} from "./cmd_batch_update.ts";
import { renderBatchGet } from "./cmd_batch_get.ts";
import { printJson } from "./emit.ts";

const SS_ID = "1SyntheticSpreadsheetIdForGoldens0000000000";

/**
 * Метаданные служебной таблицы — дословно те, с которых снят голден
 * `get-values-and-meta.stdout`: и состав ключей `properties`, и их
 * порядок. Раздела `merges` в ответе нет, и это часть эталона: путь
 * копируется, только если он в ответе есть.
 */
const META = {
  sheets: [{
    properties: {
      gridProperties: { rowCount: 1000, columnCount: 26 },
      sheetType: "GRID",
      title: "Sheet1",
      index: 0,
      sheetId: 0,
    },
  }],
};

async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/sheet-batch/${name}`, import.meta.url),
  );
}

function json(result: unknown): { status: number; text: string } {
  return { status: 200, text: JSON.stringify({ success: true, result }) };
}

/** Окружение подкоманды: подставной канал, настоящая кэш-БД. */
function harness(db: CacheDb) {
  const actions: string[] = [];
  const post = (_url: string, body: string) => {
    const request = JSON.parse(body) as {
      action: string;
      ranges?: string[];
      majorDimension?: string;
    };
    actions.push(request.action);
    if (request.action === "spreadsheets/get") {
      return Promise.resolve(json(META));
    }
    if (request.action === "spreadsheets/values/batchGet") {
      return Promise.resolve(json({
        valueRanges: [{
          range: request.ranges?.[0] ?? "",
          majorDimension: request.majorDimension,
          values: [["привет", 42], ["", "=B1*2"]],
        }],
      }));
    }
    return Promise.resolve(json({ spreadsheetId: SS_ID, replies: [{}] }));
  };
  const io = makeFakeIo({
    envFile: {
      get: (name: string) =>
        name === "WB_PLUS_WEB_APP_URL"
          ? "https://script.example/exec"
          : undefined,
      require: (name: string) => {
        if (name === "WB_PLUS_WEB_APP_URL") {
          return "https://script.example/exec";
        }
        throw new DomainError(`нет ключа ${name}`);
      },
      set: () => Promise.reject(new Error("запись env-файла не ожидается")),
      values: () => ({}),
    },
    openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }),
    readTextFile: (path: string) => {
      throw new NotFoundIoError(`нет файла ${path}`);
    },
    // stdin у теста терминал: иначе пустой вызов полез бы его читать.
    stdinIsTerminal: () => true,
    note: () => {},
  });
  // `options` изменяем: одному тесту нужен свой ответ на тот же экшен.
  const options: {
    post: (
      url: string,
      body: string,
    ) => Promise<{ status: number; text: string }>;
    nowSeconds: number;
  } = { post, nowSeconds: 1_700_000_000 };
  return { io, actions, options };
}

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

const updateArgs = (overrides: Record<string, unknown> = {}) => ({
  expression: [] as string[],
  from: undefined,
  spreadsheet: SS_ID,
  sheet: "Sheet1",
  literal: false,
  "dry-run": true,
  ...overrides,
});

const getArgs = (overrides: Record<string, unknown> = {}) => ({
  expression: [] as string[],
  from: undefined,
  spreadsheet: SS_ID,
  sheet: "Sheet1",
  "dry-run": false,
  ...overrides,
});

Deno.test("--dry-run печатает голден всех глаголов побайтно", async () => {
  await withDb(async (db) => {
    const stand = harness(db);
    const script = await golden("update-all-verbs.script");
    const result = await runBatchUpdate(
      updateArgs({ expression: [script] }),
      stand.io,
      stand.options,
    );
    assertEquals(
      renderBatchUpdate(result),
      await golden("update-all-verbs.stdout"),
    );
    // Метаданные читаются и при печати, отправки — нет.
    assertEquals(stand.actions, ["spreadsheets/get"]);
  });
});

Deno.test("боевой прогон шлёт ровно один batchUpdate и печатает ответ", async () => {
  await withDb(async (db) => {
    const stand = harness(db);
    await writeTab(db, SS_ID, "Sheet1", {
      values: [["старое"]],
      formulas: [[""]],
      dims: { rows: 1, cols: 1 },
    }, 1_700_000_000);
    const result = await runBatchUpdate(
      updateArgs({
        expression: ["trim A1:B2", "trim C1:C2"],
        "dry-run": false,
      }),
      stand.io,
      stand.options,
    );
    assertEquals(stand.actions, [
      "spreadsheets/get",
      "spreadsheets/batchUpdate",
    ]);
    assertEquals(
      renderBatchUpdate(result),
      printJson({ spreadsheetId: SS_ID, replies: [{}] }),
    );
    // Кэш листа выброшен: значения в нём больше не те, что в таблице.
    assertEquals(
      db.query(
        "SELECT tab_name FROM sheet_tabs WHERE ss_id = ?",
        SS_ID,
      ).length,
      0,
    );
  });
});

Deno.test("--dry-run не шлёт batchUpdate и кэш не трогает", async () => {
  await withDb(async (db) => {
    const stand = harness(db);
    await writeTab(db, SS_ID, "Sheet1", {
      values: [["старое"]],
      formulas: [[""]],
      dims: { rows: 1, cols: 1 },
    }, 1_700_000_000);
    await runBatchUpdate(
      updateArgs({ expression: ["trim A1:B2"] }),
      stand.io,
      stand.options,
    );
    assertEquals(stand.actions, ["spreadsheets/get"]);
    assertEquals(
      db.query("SELECT tab_name FROM sheet_tabs WHERE ss_id = ?", SS_ID).length,
      1,
    );
  });
});

Deno.test("скрипт из одних комментариев — «нет операций», без отправки", async () => {
  await withDb(async (db) => {
    const stand = harness(db);
    const result = await runBatchUpdate(
      updateArgs({ expression: ["# только заметка"], "dry-run": false }),
      stand.io,
      stand.options,
    );
    assertEquals(renderBatchUpdate(result), "нет операций\n");
    assertEquals(stand.actions, ["spreadsheets/get"]);
  });
});

Deno.test("пустой ввод — ошибка ввода до всякой сети", async () => {
  await withDb(async (db) => {
    const stand = harness(db);
    const err = await assertRejects(
      () => runBatchUpdate(updateArgs(), stand.io, stand.options),
      UsageError,
    );
    assertEquals(err.message, "пустой скрипт (-e / --from / stdin)");
    assertEquals(stand.actions, []);
  });
});

Deno.test("лист этого же скрипта: отказ дословно как в канале", async () => {
  await withDb(async (db) => {
    const stand = harness(db);
    const err = await assertRejects(
      () =>
        runBatchUpdate(
          updateArgs({
            expression: ["sheet add Врем\nsheet rename Врем Врем2"],
            sheet: undefined,
          }),
          stand.io,
          stand.options,
        ),
      UsageError,
    );
    assertEquals(
      `${formatCommandError(sheetBatchUpdateCommand.errorName, err)}\n`,
      await golden("err-sheet-created-in-same-script.stderr"),
    );
    assertEquals(stand.actions, ["spreadsheets/get"]);
  });
});

Deno.test("batch-get печатает голден значений и структуры", async () => {
  await withDb(async (db) => {
    const stand = harness(db);
    const result = await runBatchGet(
      getArgs({ expression: ["get A1:B2 formula; read Sheet1 merges props"] }),
      stand.io,
      stand.options,
    );
    assertEquals(
      stand.actions,
      ["spreadsheets/values/batchGet", "spreadsheets/get"],
    );
    assertEquals(
      renderBatchGet(result),
      await golden("get-values-and-meta.stdout"),
    );
  });
});

Deno.test("путь аспекта копируется, только если он есть в ответе", async () => {
  await withDb(async (db) => {
    const stand = harness(db);
    // Тот же вызов, но у листа появился раздел merges: в выводе он
    // обязан оказаться рядом с properties — и только он.
    stand.options.post = (_url: string, body: string) => {
      const action = (JSON.parse(body) as { action: string }).action;
      if (action !== "spreadsheets/get") return Promise.resolve(json({}));
      return Promise.resolve(json({
        sheets: [{
          ...META.sheets[0],
          merges: [{ sheetId: 0, startRowIndex: 0, endRowIndex: 1 }],
        }],
      }));
    };
    const result = await runBatchGet(
      getArgs({ expression: ["read Sheet1 merges cond"] }),
      stand.io,
      stand.options,
    );
    assertEquals(result.meta, {
      sheets: [{
        title: "Sheet1",
        merges: [{ sheetId: 0, startRowIndex: 0, endRowIndex: 1 }],
      }],
    });
  });
});

Deno.test("--dry-run batch-get не делает ни одного вызова", async () => {
  await withDb(async (db) => {
    const stand = harness(db);
    const result = await runBatchGet(
      getArgs({ expression: ["get A1:B2"], "dry-run": true }),
      stand.io,
      stand.options,
    );
    assertEquals(stand.actions, []);
    assertEquals(
      renderBatchGet(result),
      printJson({
        values: {
          ssId: SS_ID,
          ranges: ["Sheet1!A1:B2"],
          majorDimension: "ROWS",
          valueRenderOption: "FORMATTED_VALUE",
          dateTimeRenderOption: "SERIAL_NUMBER",
        },
        meta: null,
      }),
    );
  });
});

Deno.test("batch-get не пишет и не читает кэш листов", async () => {
  await withDb(async (db) => {
    const stand = harness(db);
    // В кэше заведомо другие значения: если бы команда его читала,
    // в ответе оказалось бы «из кэша», а не «привет».
    await writeTab(db, SS_ID, "Sheet1", {
      values: [["из кэша"]],
      formulas: [[""]],
      dims: { rows: 1, cols: 1 },
    }, 1_700_000_000);
    const result = await runBatchGet(
      getArgs({ expression: ["get A1:B2"] }),
      stand.io,
      stand.options,
    );
    assertEquals(stand.actions, ["spreadsheets/values/batchGet"]);
    const values = result.values as { valueRanges: [{ values: unknown[][] }] };
    assertEquals(values.valueRanges[0].values[0][0], "привет");
    // И запись кэша не тронута: чтение её не обновляет.
    assertEquals(
      db.query(
        "SELECT payload FROM sheet_tabs WHERE ss_id = ? AND tab_name = ?",
        SS_ID,
        "Sheet1",
      ).length,
      1,
    );
  });
});
