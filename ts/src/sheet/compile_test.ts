/**
 * Компиляция мини-языка (`docs/specs/sheet-batch.md`). Главный тест —
 * голден всех глаголов: он и есть контракт таблицы «инструкция →
 * запрос», и сверяется побайтно.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { UsageError } from "../command/mod.ts";
import { compileScript } from "./compile.ts";
import { printJson } from "./emit.ts";
import type { SheetRef } from "./grid.ts";

const SHEETS: readonly SheetRef[] = [{ title: "Sheet1", sheetId: 0 }];

async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/sheet-batch/${name}`, import.meta.url),
  );
}

Deno.test("голден всех глаголов компилируется побайтно", async () => {
  const script = await golden("update-all-verbs.script");
  const compiled = compileScript(script, {
    sheets: SHEETS,
    defaultSheet: "Sheet1",
  });
  assertEquals(compiled.requests.length, 34);
  assertEquals(
    printJson({ requests: compiled.requests }),
    await golden("update-all-verbs.stdout"),
  );
});

Deno.test("порядок запросов равен порядку инструкций", () => {
  const compiled = compileScript("trim A1:B2\nunmerge A1:B2", {
    sheets: SHEETS,
    defaultSheet: "Sheet1",
  });
  assertEquals(compiled.requests.map((r) => Object.keys(r as object)[0]), [
    "trimWhitespace",
    "unmergeCells",
  ]);
});

Deno.test("лист, создаваемый этим же скриптом, на компиляции не существует", () => {
  const err = assertThrows(
    () =>
      compileScript("sheet add Врем\nsheet rename Врем Врем2", {
        sheets: SHEETS,
      }),
    UsageError,
  );
  assertEquals(err.message, "строка 2: лист 'Врем' не найден в таблице");
});

Deno.test("py{…} не поддерживается и отбивается до всякой работы", () => {
  const err = assertThrows(
    () => compileScript("py{ emit('trim A1') }", { sheets: SHEETS }),
    UsageError,
  );
  assertEquals(
    err.message,
    "строка 1: py{…} не поддерживается; собери инструкции сами и передай " +
      "готовым скриптом",
  );
});

Deno.test("затронутые листы собираются для инвалидации кэша", () => {
  const compiled = compileScript("trim 'Второй'!A1:B2\ntrim Sheet1!A1", {
    sheets: [...SHEETS, { title: "Второй", sheetId: 7 }],
  });
  assertEquals(compiled.sheetIds, [0, 7]);
});

Deno.test("generic-инструкция разворачивает сахар по всему объекту", () => {
  const compiled = compileScript(
    '@repeatCell { "range": "@A1:B2", "cell": { "userEnteredFormat": ' +
      '{ "backgroundColor": "#00FF00", "note": "#не-цвет" } } }',
    { sheets: SHEETS, defaultSheet: "Sheet1" },
  );
  // Сверяется печать, а не структура: доли цвета живут в обёртке,
  // печатающей питоновскую форму (`emit.ts`).
  assertEquals(
    printJson(compiled.requests[0]),
    `{
  "repeatCell": {
    "range": {
      "sheetId": 0,
      "startRowIndex": 0,
      "endRowIndex": 2,
      "startColumnIndex": 0,
      "endColumnIndex": 2
    },
    "cell": {
      "userEnteredFormat": {
        "backgroundColor": {
          "red": 0.0,
          "green": 1.0,
          "blue": 0.0
        },
        "note": "#не-цвет"
      }
    }
  }
}
`,
  );
});

Deno.test("sheetId в generic — имя листа, а не число", () => {
  const compiled = compileScript(
    '@deleteSheet { "sheetId": "@\'Второй\'" }',
    { sheets: [...SHEETS, { title: "Второй", sheetId: 7 }] },
  );
  assertEquals(compiled.requests[0], { deleteSheet: { sheetId: 7 } });
});

Deno.test("raw уходит дословно, без сахара", () => {
  const compiled = compileScript('raw { "any": { "range": "@A1" } }', {
    sheets: SHEETS,
    defaultSheet: "Sheet1",
  });
  assertEquals(compiled.requests[0], { any: { range: "@A1" } });
});

Deno.test("не-объект и битый JSON — разные ошибки компиляции", () => {
  assertThrows(
    () => compileScript("@x [1,2]", { sheets: SHEETS }),
    UsageError,
    "ожидался JSON-объект",
  );
  assertThrows(
    () => compileScript("@x { [1,2] }", { sheets: SHEETS }),
    UsageError,
    "плохой JSON: ",
  );
  // Объект без ключей объектом быть не перестаёт — это не ошибка.
  assertEquals(
    compileScript("@x { }", { sheets: SHEETS }).requests[0],
    { x: {} },
  );
});

Deno.test("сортировка по одному столбцу — массив из одной записи", () => {
  // Скаляр Sheets API не принимает: `sortSpecs` объявлен списком, и
  // единственный столбец не делает его одиночным значением.
  const compiled = compileScript("sort A1:B9 by=A", {
    sheets: SHEETS,
    defaultSheet: "Sheet1",
  });
  assertEquals(compiled.requests[0], {
    sortRange: {
      range: {
        sheetId: 0,
        startRowIndex: 0,
        endRowIndex: 9,
        startColumnIndex: 0,
        endColumnIndex: 2,
      },
      sortSpecs: [{ dimensionIndex: 0, sortOrder: "ASCENDING" }],
    },
  });
});

Deno.test("one-of с одним значением — список из одного, а не строка", () => {
  const compiled = compileScript("validate A1 one-of=да", {
    sheets: SHEETS,
    defaultSheet: "Sheet1",
  });
  const request = compiled.requests[0] as {
    setDataValidation: { rule: { condition: unknown } };
  };
  assertEquals(request.setDataValidation.rule.condition, {
    type: "ONE_OF_LIST",
    values: [{ userEnteredValue: "да" }],
  });
});

Deno.test("editors из одного адреса — тоже список", () => {
  const compiled = compileScript("protect A1:B2 editors=a@x.test", {
    sheets: SHEETS,
    defaultSheet: "Sheet1",
  });
  const request = compiled.requests[0] as {
    addProtectedRange: { protectedRange: { editors: unknown } };
  };
  assertEquals(request.addProtectedRange.protectedRange.editors, {
    users: ["a@x.test"],
  });
});

Deno.test("find-replace: searchByRegex ложен без слова regex", () => {
  const plain = compileScript("find-replace старое новое", {
    sheets: SHEETS,
    defaultSheet: "Sheet1",
  });
  assertEquals(plain.requests[0], {
    findReplace: {
      find: "старое",
      replacement: "новое",
      searchByRegex: false,
      sheetId: 0,
    },
  });
  const regex = compileScript("find-replace старое новое regex case", {
    sheets: SHEETS,
    defaultSheet: "Sheet1",
  });
  assertEquals(regex.requests[0], {
    findReplace: {
      find: "старое",
      replacement: "новое",
      matchCase: true,
      searchByRegex: true,
      sheetId: 0,
    },
  });
});

Deno.test("find-replace без области и без -n — ошибка, а не вся таблица", () => {
  const err = assertThrows(
    () => compileScript("find-replace а б", { sheets: SHEETS }),
    UsageError,
  );
  assertEquals(
    err.message,
    "строка 1: нет области — задай -n, allsheets или 'Лист'!span",
  );
});

Deno.test("неопознанное слово-опция — ошибка, а не молчание", () => {
  for (
    const [script, message] of [
      ["merge A1:B2 колонки", "строка 1: неизвестная опция 'колонки'"],
      [
        "cols insert A inherit=befor",
        "строка 1: неизвестная опция 'inherit=befor'",
      ],
      ["clear A1 частично", "строка 1: неизвестная опция 'частично'"],
    ]
  ) {
    const err = assertThrows(
      () => compileScript(script, { sheets: SHEETS, defaultSheet: "Sheet1" }),
      UsageError,
    );
    assertEquals(err.message, message);
  }
});

Deno.test("опечатка во втором слове называет пару целиком", () => {
  const err = assertThrows(
    () =>
      compileScript("cols insrt A", { sheets: SHEETS, defaultSheet: "Sheet1" }),
    UsageError,
  );
  assertEquals(err.message, "строка 1: неизвестный глагол 'cols insrt'");
});

Deno.test("set пишет одну ячейку, открытая граница значит первую", () => {
  const compiled = compileScript("set H:H 5", {
    sheets: SHEETS,
    defaultSheet: "Sheet1",
  });
  const request = compiled.requests[0] as { updateCells: { start: unknown } };
  assertEquals(request.updateCells.start, {
    sheetId: 0,
    rowIndex: 0,
    columnIndex: 7,
  });
});

Deno.test("r5c8 — одиночная ячейка в R1C1", () => {
  const compiled = compileScript("trim R5C8", {
    sheets: SHEETS,
    defaultSheet: "Sheet1",
  });
  assertEquals(compiled.requests[0], {
    trimWhitespace: {
      range: {
        sheetId: 0,
        startRowIndex: 4,
        endRowIndex: 5,
        startColumnIndex: 7,
        endColumnIndex: 8,
      },
    },
  });
});

Deno.test("открытая граница в запрос не попадает", () => {
  const compiled = compileScript("trim H2:H", {
    sheets: SHEETS,
    defaultSheet: "Sheet1",
  });
  assertEquals(compiled.requests[0], {
    trimWhitespace: {
      range: {
        sheetId: 0,
        startRowIndex: 1,
        startColumnIndex: 7,
        endColumnIndex: 8,
      },
    },
  });
});

Deno.test("буква как индекс строки — ошибка с названной размерностью", () => {
  const err = assertThrows(
    () =>
      compileScript("rows delete H", {
        sheets: SHEETS,
        defaultSheet: "Sheet1",
      }),
    UsageError,
  );
  assertEquals(err.message, "строка 1: плохой индекс 'H' для ROWS");
});

Deno.test("-l делает значением строку, чем бы токен ни выглядел", () => {
  const compiled = compileScript("set A1 42", {
    sheets: SHEETS,
    defaultSheet: "Sheet1",
    literal: true,
  });
  const request = compiled.requests[0] as {
    updateCells: { rows: [{ values: [{ userEnteredValue: unknown }] }] };
  };
  assertEquals(request.updateCells.rows[0].values[0].userEnteredValue, {
    stringValue: "42",
  });
});

Deno.test("лишнее слово отбивается у каждого глагола с опциями", () => {
  for (
    const script of [
      "sort A1:B9 by=A мусор",
      "dedupe A1:B9 мусор",
      "cols resize A px=10 мусор",
      "freeze Sheet1 rows=1 мусор",
      "border A1:B2 around мусор",
      "validate A1 blank мусор",
      "protect A1 мусор",
      "cond clear Sheet1 мусор",
      "copy A1 -> B1 мусор",
      "cut A1 -> B1 мусор",
      "sheet add Новый мусор",
    ]
  ) {
    const err = assertThrows(
      () => compileScript(script, { sheets: SHEETS, defaultSheet: "Sheet1" }),
      UsageError,
      "неизвестная опция 'мусор'",
      script,
    );
    assertEquals(err.message.startsWith("строка 1: "), true, script);
  }
});

Deno.test("сторона рамки, названная дважды, — ошибка, а не тихая потеря", () => {
  const err = assertThrows(
    () =>
      compileScript("border A1:B2 top bottom", {
        sheets: SHEETS,
        defaultSheet: "Sheet1",
      }),
    UsageError,
  );
  assertEquals(
    err.message,
    "строка 1: сторона названа дважды: 'top' и 'bottom'",
  );
});

Deno.test("freeze: лист — только первый токен", () => {
  const err = assertThrows(
    () =>
      compileScript("freeze Лишний Sheet1 rows=1", {
        sheets: SHEETS,
        defaultSheet: "Sheet1",
      }),
    UsageError,
  );
  // Раньше `Лишний` молча затирался вторым бесключевым токеном.
  assertEquals(err.message, "строка 1: неизвестная опция 'Sheet1'");
});

Deno.test("custom==Ф и голое =Ф дают один и тот же запрос", () => {
  const of = (script: string) => {
    const request = compileScript(script, {
      sheets: SHEETS,
      defaultSheet: "Sheet1",
    }).requests[0] as { setDataValidation: { rule: { condition: unknown } } };
    return request.setDataValidation.rule.condition;
  };
  assertEquals(of("validate A1 custom==A1>1"), {
    type: "CUSTOM_FORMULA",
    values: [{ userEnteredValue: "=A1>1" }],
  });
  assertEquals(of("validate A1 =A1>1"), of("validate A1 custom==A1>1"));
});

Deno.test("нулевой индекс в A1 — ошибка ввода, а не отрицательная граница", () => {
  for (const script of ["set A0 5", "trim A1:B0", "trim 0:2"]) {
    assertThrows(
      () => compileScript(script, { sheets: SHEETS, defaultSheet: "Sheet1" }),
      UsageError,
      "невалидный диапазон",
      script,
    );
  }
});

Deno.test("опечатка во втором слове называет пару у любого семейства", () => {
  for (
    const [script, message] of [
      ["cols insrt A", "строка 1: неизвестный глагол 'cols insrt'"],
      ["group colz A", "строка 1: неизвестный глагол 'group colz'"],
      ["append rowz 2", "строка 1: неизвестный глагол 'append rowz'"],
      ["sheet ad Новый", "строка 1: неизвестный глагол 'sheet ad'"],
    ]
  ) {
    const err = assertThrows(
      () => compileScript(script, { sheets: SHEETS, defaultSheet: "Sheet1" }),
      UsageError,
    );
    assertEquals(err.message, message);
  }
});

Deno.test("insert наследует формат слева, но не на нулевом индексе", () => {
  const inherit = (script: string) => {
    const request = compileScript(script, {
      sheets: SHEETS,
      defaultSheet: "Sheet1",
    }).requests[0] as { insertDimension: { inheritFromBefore: boolean } };
    return request.insertDimension.inheritFromBefore;
  };
  // Умолчание — наследовать: столбец вставляют рядом с похожим.
  assertEquals(inherit("cols insert B"), true);
  assertEquals(inherit("cols insert B inherit"), true);
  assertEquals(inherit("cols insert B inherit=before"), true);
  assertEquals(inherit("cols insert B inherit=after"), false);
  // На левом краю наследовать нечего, и Google отвечает отказом
  // «range.startIndex must not be 0 if inheritFromBefore is true» —
  // падает вся пачка, поэтому признак ложен при любом вводе.
  assertEquals(inherit("cols insert A"), false);
  assertEquals(inherit("cols insert A inherit"), false);
  assertEquals(inherit("rows insert 1"), false);
});

Deno.test("шаблон в слэшах — регэксп, и слэши снимаются", () => {
  const of = (script: string) => {
    const request = compileScript(script, {
      sheets: SHEETS,
      defaultSheet: "Sheet1",
    }).requests[0] as { findReplace: Record<string, unknown> };
    return request.findReplace;
  };
  assertEquals(of("find-replace /ab.*/ x"), {
    find: "ab.*",
    replacement: "x",
    searchByRegex: true,
    sheetId: 0,
  });
  // Слово `regex` включает то же самое без слэшей.
  assertEquals(of("find-replace ab.* x regex"), {
    find: "ab.*",
    replacement: "x",
    searchByRegex: true,
    sheetId: 0,
  });
  // Одиночный слэш шаблоном в слэшах не является.
  assertEquals(of("find-replace / x"), {
    find: "/",
    replacement: "x",
    searchByRegex: false,
    sheetId: 0,
  });
});
