/**
 * Компиляция мини-языка (`docs/specs/sheet-batch.md`). Главный тест —
 * голден всех глаголов: он и есть контракт таблицы «инструкция →
 * запрос», и сверяется побайтно.
 */

import { readFile } from "node:fs/promises";
import { assert, expect, it } from "vitest";
import { thrown } from "../testing/thrown.ts";
import { UsageError } from "../command/mod.ts";
import { compileScript } from "./compile.ts";
import { printJson } from "./emit.ts";
import type { SheetRef } from "./grid.ts";

const SHEETS: readonly SheetRef[] = [{ title: "Sheet1", sheetId: 0 }];

async function golden(name: string): Promise<string> {
  return await readFile(
    new URL(`./testdata/sheet-batch/${name}`, import.meta.url),
    "utf8",
  );
}

it("голден всех глаголов компилируется побайтно", async () => {
  const script = await golden("update-all-verbs.script");
  const compiled = compileScript(script, {
    sheets: SHEETS,
    defaultSheet: "Sheet1",
  });
  expect(compiled.requests.length).toBe(34);
  expect(printJson({ requests: compiled.requests })).toStrictEqual(
    await golden("update-all-verbs.stdout"),
  );
});

it("порядок запросов равен порядку инструкций", () => {
  const compiled = compileScript("trim A1:B2\nunmerge A1:B2", {
    sheets: SHEETS,
    defaultSheet: "Sheet1",
  });
  expect(compiled.requests.map((r) => Object.keys(r as object)[0]))
    .toStrictEqual([
      "trimWhitespace",
      "unmergeCells",
    ]);
});

it("лист, создаваемый этим же скриптом, на компиляции не существует", () => {
  const err = thrown(() => {
    compileScript("sheet add Врем\nsheet rename Врем Врем2", {
      sheets: SHEETS,
    });
  }, UsageError);
  expect(err.message).toBe("строка 2: лист 'Врем' не найден в таблице");
});

it("py{…} не поддерживается и отбивается до всякой работы", () => {
  const err = thrown(() => {
    compileScript("py{ emit('trim A1') }", { sheets: SHEETS });
  }, UsageError);
  expect(err.message).toStrictEqual(
    "строка 1: py{…} не поддерживается; собери инструкции сами и передай " +
      "готовым скриптом",
  );
});

it("затронутые листы собираются для инвалидации кэша", () => {
  const compiled = compileScript("trim 'Второй'!A1:B2\ntrim Sheet1!A1", {
    sheets: [...SHEETS, { title: "Второй", sheetId: 7 }],
  });
  expect(compiled.sheetIds).toStrictEqual([0, 7]);
});

it("generic-инструкция разворачивает сахар по всему объекту", () => {
  const compiled = compileScript(
    '@repeatCell { "range": "@A1:B2", "cell": { "userEnteredFormat": ' +
      '{ "backgroundColor": "#00FF00", "note": "#не-цвет" } } }',
    { sheets: SHEETS, defaultSheet: "Sheet1" },
  );
  // Сверяется печать, а не структура: доли цвета живут в обёртке,
  // печатающей питоновскую форму (`emit.ts`).
  expect(printJson(compiled.requests[0])).toBe(`{
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
`);
});

it("sheetId в generic — имя листа, а не число", () => {
  const compiled = compileScript(
    '@deleteSheet { "sheetId": "@\'Второй\'" }',
    { sheets: [...SHEETS, { title: "Второй", sheetId: 7 }] },
  );
  expect(compiled.requests[0]).toStrictEqual({ deleteSheet: { sheetId: 7 } });
});

it("raw уходит дословно, без сахара", () => {
  const compiled = compileScript('raw { "any": { "range": "@A1" } }', {
    sheets: SHEETS,
    defaultSheet: "Sheet1",
  });
  expect(compiled.requests[0]).toStrictEqual({ any: { range: "@A1" } });
});

it("не-объект и битый JSON — разные ошибки компиляции", () => {
  expect(() => compileScript("@x [1,2]", { sheets: SHEETS })).toThrow(
    UsageError,
  );
  expect(() => compileScript("@x [1,2]", { sheets: SHEETS })).toThrow(
    "ожидался JSON-объект",
  );
  expect(() => compileScript("@x { [1,2] }", { sheets: SHEETS })).toThrow(
    UsageError,
  );
  expect(() => compileScript("@x { [1,2] }", { sheets: SHEETS })).toThrow(
    "плохой JSON: ",
  );
  // Объект без ключей объектом быть не перестаёт — это не ошибка.
  expect(compileScript("@x { }", { sheets: SHEETS }).requests[0]).toStrictEqual(
    { x: {} },
  );
});

it("сортировка по одному столбцу — массив из одной записи", () => {
  // Скаляр Sheets API не принимает: `sortSpecs` объявлен списком, и
  // единственный столбец не делает его одиночным значением.
  const compiled = compileScript("sort A1:B9 by=A", {
    sheets: SHEETS,
    defaultSheet: "Sheet1",
  });
  expect(compiled.requests[0]).toStrictEqual({
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

it("one-of с одним значением — список из одного, а не строка", () => {
  const compiled = compileScript("validate A1 one-of=да", {
    sheets: SHEETS,
    defaultSheet: "Sheet1",
  });
  const request = compiled.requests[0] as {
    setDataValidation: { rule: { condition: unknown } };
  };
  expect(request.setDataValidation.rule.condition).toStrictEqual({
    type: "ONE_OF_LIST",
    values: [{ userEnteredValue: "да" }],
  });
});

it("editors из одного адреса — тоже список", () => {
  const compiled = compileScript("protect A1:B2 editors=a@x.test", {
    sheets: SHEETS,
    defaultSheet: "Sheet1",
  });
  const request = compiled.requests[0] as {
    addProtectedRange: { protectedRange: { editors: unknown } };
  };
  expect(request.addProtectedRange.protectedRange.editors).toStrictEqual({
    users: ["a@x.test"],
  });
});

it("find-replace: searchByRegex ложен без слова regex", () => {
  const plain = compileScript("find-replace старое новое", {
    sheets: SHEETS,
    defaultSheet: "Sheet1",
  });
  expect(plain.requests[0]).toStrictEqual({
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
  expect(regex.requests[0]).toStrictEqual({
    findReplace: {
      find: "старое",
      replacement: "новое",
      matchCase: true,
      searchByRegex: true,
      sheetId: 0,
    },
  });
});

it("find-replace без области и без -n — ошибка, а не вся таблица", () => {
  const err = thrown(() => {
    compileScript("find-replace а б", { sheets: SHEETS });
  }, UsageError);
  expect(err.message).toBe(
    "строка 1: нет области — задай -n, allsheets или 'Лист'!span",
  );
});

it("неопознанное слово-опция — ошибка, а не молчание", () => {
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
    const err = thrown(() => {
      compileScript(script, { sheets: SHEETS, defaultSheet: "Sheet1" });
    }, UsageError);
    expect(err.message).toStrictEqual(message);
  }
});

it("опечатка во втором слове называет пару целиком", () => {
  const err = thrown(() => {
    compileScript("cols insrt A", { sheets: SHEETS, defaultSheet: "Sheet1" });
  }, UsageError);
  expect(err.message).toBe("строка 1: неизвестный глагол 'cols insrt'");
});

it("set пишет одну ячейку, открытая граница значит первую", () => {
  const compiled = compileScript("set H:H 5", {
    sheets: SHEETS,
    defaultSheet: "Sheet1",
  });
  const request = compiled.requests[0] as { updateCells: { start: unknown } };
  expect(request.updateCells.start).toStrictEqual({
    sheetId: 0,
    rowIndex: 0,
    columnIndex: 7,
  });
});

it("r5c8 — одиночная ячейка в R1C1", () => {
  const compiled = compileScript("trim R5C8", {
    sheets: SHEETS,
    defaultSheet: "Sheet1",
  });
  expect(compiled.requests[0]).toStrictEqual({
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

it("открытая граница в запрос не попадает", () => {
  const compiled = compileScript("trim H2:H", {
    sheets: SHEETS,
    defaultSheet: "Sheet1",
  });
  expect(compiled.requests[0]).toStrictEqual({
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

it("буква как индекс строки — ошибка с названной размерностью", () => {
  const err = thrown(() => {
    compileScript("rows delete H", {
      sheets: SHEETS,
      defaultSheet: "Sheet1",
    });
  }, UsageError);
  expect(err.message).toBe("строка 1: плохой индекс 'H' для ROWS");
});

it("-l делает значением строку, чем бы токен ни выглядел", () => {
  const compiled = compileScript("set A1 42", {
    sheets: SHEETS,
    defaultSheet: "Sheet1",
    literal: true,
  });
  const request = compiled.requests[0] as {
    updateCells: { rows: [{ values: [{ userEnteredValue: unknown }] }] };
  };
  expect(request.updateCells.rows[0].values[0].userEnteredValue).toStrictEqual({
    stringValue: "42",
  });
});

it("лишнее слово отбивается у каждого глагола с опциями", () => {
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
    // Ручная поимка, а не `thrown`: падение называет скрипт цикла.
    let err: unknown;
    try {
      compileScript(script, { sheets: SHEETS, defaultSheet: "Sheet1" });
    } catch (error) {
      err = error;
    }
    assert(err instanceof UsageError, script);
    expect(err.message, script).toContain("неизвестная опция 'мусор'");
    expect(err.message.startsWith("строка 1: "), script).toBe(true);
  }
});

it("сторона рамки, названная дважды, — ошибка, а не тихая потеря", () => {
  const err = thrown(() => {
    compileScript("border A1:B2 top bottom", {
      sheets: SHEETS,
      defaultSheet: "Sheet1",
    });
  }, UsageError);
  expect(err.message).toBe(
    "строка 1: сторона названа дважды: 'top' и 'bottom'",
  );
});

it("freeze: лист — только первый токен", () => {
  const err = thrown(() => {
    compileScript("freeze Лишний Sheet1 rows=1", {
      sheets: SHEETS,
      defaultSheet: "Sheet1",
    });
  }, UsageError);
  // Раньше `Лишний` молча затирался вторым бесключевым токеном.
  expect(err.message).toBe("строка 1: неизвестная опция 'Sheet1'");
});

it("custom==Ф и голое =Ф дают один и тот же запрос", () => {
  const of = (script: string) => {
    const request = compileScript(script, {
      sheets: SHEETS,
      defaultSheet: "Sheet1",
    }).requests[0] as { setDataValidation: { rule: { condition: unknown } } };
    return request.setDataValidation.rule.condition;
  };
  expect(of("validate A1 custom==A1>1")).toStrictEqual({
    type: "CUSTOM_FORMULA",
    values: [{ userEnteredValue: "=A1>1" }],
  });
  expect(of("validate A1 =A1>1")).toStrictEqual(of("validate A1 custom==A1>1"));
});

it("нулевой индекс в A1 — ошибка ввода, а не отрицательная граница", () => {
  for (const script of ["set A0 5", "trim A1:B0", "trim 0:2"]) {
    const compile = () =>
      compileScript(script, { sheets: SHEETS, defaultSheet: "Sheet1" });
    expect(compile, script).toThrow(UsageError);
    expect(compile, script).toThrow("невалидный диапазон");
  }
});

it("опечатка во втором слове называет пару у любого семейства", () => {
  for (
    const [script, message] of [
      ["cols insrt A", "строка 1: неизвестный глагол 'cols insrt'"],
      ["group colz A", "строка 1: неизвестный глагол 'group colz'"],
      ["append rowz 2", "строка 1: неизвестный глагол 'append rowz'"],
      ["sheet ad Новый", "строка 1: неизвестный глагол 'sheet ad'"],
    ]
  ) {
    const err = thrown(() => {
      compileScript(script, { sheets: SHEETS, defaultSheet: "Sheet1" });
    }, UsageError);
    expect(err.message).toStrictEqual(message);
  }
});

it("insert наследует формат слева, но не на нулевом индексе", () => {
  const inherit = (script: string) => {
    const request = compileScript(script, {
      sheets: SHEETS,
      defaultSheet: "Sheet1",
    }).requests[0] as { insertDimension: { inheritFromBefore: boolean } };
    return request.insertDimension.inheritFromBefore;
  };
  // Умолчание — наследовать: столбец вставляют рядом с похожим.
  expect(inherit("cols insert B")).toBe(true);
  expect(inherit("cols insert B inherit")).toBe(true);
  expect(inherit("cols insert B inherit=before")).toBe(true);
  expect(inherit("cols insert B inherit=after")).toBe(false);
  // На левом краю наследовать нечего, и Google отвечает отказом
  // «range.startIndex must not be 0 if inheritFromBefore is true» —
  // падает вся пачка, поэтому признак ложен при любом вводе.
  expect(inherit("cols insert A")).toBe(false);
  expect(inherit("cols insert A inherit")).toBe(false);
  expect(inherit("rows insert 1")).toBe(false);
});

it("шаблон в слэшах — регэксп, и слэши снимаются", () => {
  const of = (script: string) => {
    const request = compileScript(script, {
      sheets: SHEETS,
      defaultSheet: "Sheet1",
    }).requests[0] as { findReplace: Record<string, unknown> };
    return request.findReplace;
  };
  expect(of("find-replace /ab.*/ x")).toStrictEqual({
    find: "ab.*",
    replacement: "x",
    searchByRegex: true,
    sheetId: 0,
  });
  // Слово `regex` включает то же самое без слэшей.
  expect(of("find-replace ab.* x regex")).toStrictEqual({
    find: "ab.*",
    replacement: "x",
    searchByRegex: true,
    sheetId: 0,
  });
  // Одиночный слэш шаблоном в слэшах не является.
  expect(of("find-replace / x")).toStrictEqual({
    find: "/",
    replacement: "x",
    searchByRegex: false,
    sheetId: 0,
  });
});
