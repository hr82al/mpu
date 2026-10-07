/**
 * Формы вывода результата (`specs/sql-ro.md`, «Ввод/вывод»): ASCII-таблица,
 * `--json`, `--md` и строка «без набора строк». Сверка с эталонами канала
 * побайтовая — в таблице значима правая добивка пробелами, и глазами её
 * в отчёте о падении не видно.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { renderOutcome, type SqlOutcome } from "./render.ts";

const NULLS: SqlOutcome = {
  kind: "rows",
  columns: ["n", "t", "u"],
  rows: [[1, null, "ы"], [22, "xx", null]],
};

const EMPTY: SqlOutcome = {
  kind: "rows",
  columns: ["n", "longcolumnname"],
  rows: [],
};

const ESCAPES: SqlOutcome = {
  kind: "rows",
  columns: ["pipe", "bslash", "nl"],
  rows: [["a|b", "c\\d", "e\nf"]],
};

function golden(name: string): Promise<string> {
  return readFile(new URL(`testdata/${name}`, import.meta.url), "utf8");
}

describe("ASCII-таблица: эталоны канала байт в байт", () => {
  const cases: readonly [string, string, SqlOutcome][] = [
    ["table-nulls-stdout.txt", "NULL — пустая строка, добивка справа", NULLS],
    ["table-empty-stdout.txt", "0 строк: шапка без разделителя", EMPTY],
    [
      "table-multiline-stdout.txt",
      "перевод строки в значении не экранируется",
      ESCAPES,
    ],
    ["semi-first-stdout.txt", "результат первого оператора", {
      kind: "rows",
      columns: ["a"],
      rows: [[1]],
    }],
    ["noresultset-stdout.txt", "запрос без набора строк", {
      kind: "done",
      rowcount: -1,
    }],
  ];
  for (const [name, title, outcome] of cases) {
    it(`${name}: ${title}`, async () => {
      expect(renderOutcome(outcome, "table")).toStrictEqual(await golden(name));
    });
  }
});

describe("--json: эталоны канала байт в байт", () => {
  const cases: readonly [string, SqlOutcome][] = [
    ["table-nulls-json.txt", NULLS],
    ["select1-stdout.json", { kind: "rows", columns: ["one"], rows: [[1]] }],
  ];
  for (const [name, outcome] of cases) {
    it(name, async () => {
      expect(renderOutcome(outcome, "json")).toStrictEqual(await golden(name));
    });
  }
});

describe("--md: эталоны канала байт в байт", () => {
  const cases: readonly [string, SqlOutcome][] = [
    ["table-nulls-md.txt", NULLS],
    ["table-empty-md.txt", EMPTY],
    ["table-md-escapes.txt", ESCAPES],
  ];
  for (const [name, outcome] of cases) {
    it(name, async () => {
      expect(renderOutcome(outcome, "md")).toStrictEqual(await golden(name));
    });
  }
});

describe("формы, эталонов которым канал не даёт", () => {
  it("0 строк в --json — пустой массив", () => {
    expect(renderOutcome({ kind: "rows", columns: ["n"], rows: [] }, "json"))
      .toBe("[]\n");
  });
  it("без набора строк в --json — одна строка", () => {
    expect(renderOutcome({ kind: "done", rowcount: 3 }, "json")).toBe(
      '{"ok": true, "rowcount": 3}\n',
    );
  });
  it("без набора строк в --md — та же строка, что в таблице", () => {
    expect(renderOutcome({ kind: "done", rowcount: -1 }, "md")).toBe(
      "OK (rowcount=-1)\n",
    );
  });
  it("большая выборка печатается, а не роняет процесс", () => {
    // Ширина колонки считается обходом, а не раскрытием массива в
    // аргументы: у V8 предел на число аргументов около 125 тысяч, и
    // `SELECT generate_series(1, 200000)` ронял бы вызов RangeError'ом.
    const rows = Array.from({ length: 130_000 }, (_, i) => [i]);
    const text = renderOutcome({ kind: "rows", columns: ["n"], rows }, "table");
    expect(text.endsWith("\n(130000 rows)\n")).toBe(true);
  });
  it("ширина колонки считается по кодовым точкам", () => {
    expect(renderOutcome({
      kind: "rows",
      columns: ["c"],
      rows: [["日本"], ["x"]],
    }, "table")).toBe("c \n--\n日本\nx \n(2 rows)\n");
  });
  it("значение без JSON-представления — текстовой формой", () => {
    // Ячейка приходит уже приведённой драйвером (`pg.ts`), но структуры
    // JSON-типов доходят как есть: в таблице у них текстовая форма, в
    // `--json` — вложенный объект.
    const outcome: SqlOutcome = {
      kind: "rows",
      columns: ["j", "arr"],
      rows: [[{ a: 1 }, [1, null]]],
    };
    expect(renderOutcome(outcome, "table")).toBe(
      'j         arr      \n--------  ---------\n{"a": 1}  [1, null]\n(1 rows)\n',
    );
    expect(renderOutcome(outcome, "json")).toBe(
      '[{"j": {"a": 1}, "arr": [1, null]}]\n',
    );
  });
});
