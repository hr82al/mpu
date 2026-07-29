import { assertEquals, assertThrows } from "@std/assert";
import {
  type AreaRef,
  cellName,
  colLetters,
  parseColLetters,
  parseRangeToken,
  prefixRangeToken,
  type RangeTarget,
  resolveArea,
} from "./range.ts";
import { UsageError } from "./errors.ts";

function area(
  startCol?: number,
  startRow?: number,
  endCol?: number,
  endRow?: number,
  sheet?: string,
): RangeTarget {
  return { kind: "area", sheet, area: { startCol, startRow, endCol, endRow } };
}

Deno.test("parseRangeToken: валидные формы", async (t) => {
  const cases: readonly (readonly [string, RangeTarget])[] = [
    ["A1", area(1, 1, 1, 1)],
    ["b2", area(2, 2, 2, 2)],
    ["A1:C3", area(1, 1, 3, 3)],
    ["C3:A1", area(3, 3, 1, 1)],
    ["A:A", area(1, undefined, 1, undefined)],
    ["1:5", area(undefined, 1, undefined, 5)],
    ["A1:A", area(1, 1, 1, undefined)],
    ["A:B5", area(1, undefined, 2, 5)],
    ["Данные!A1", area(1, 1, 1, 1, "Данные")],
    ["'Мой лист'!B2:B3", area(2, 2, 2, 3, "Мой лист")],
    ["'O''Hara'!A1", area(1, 1, 1, 1, "O'Hara")],
    ["Данные", { kind: "wholeSheet", sheet: "Данные" }],
    ["'Лист с пробелом'", { kind: "wholeSheet", sheet: "Лист с пробелом" }],
    // Буквы без строки и без «:» — имя листа, не колонка (см. отчёт).
    ["A", { kind: "wholeSheet", sheet: "A" }],
  ];
  for (const [token, expected] of cases) {
    await t.step(token, () => {
      assertEquals(parseRangeToken(token), expected);
    });
  }
});

Deno.test("parseRangeToken: невалидные формы — UsageError", async (t) => {
  const cases: readonly string[] = [
    "",
    "Данные!",
    "!A1",
    "Данные!A0",
    "Данные!Пустой",
    "Данные!A",
    "'unclosed!A1",
    "'Лист'мусор",
    "Данные!A1:",
    "Данные!:B2",
    "Данные!XFE1", // за пределом колонок Excel
  ];
  for (const token of cases) {
    await t.step(token === "" ? "(пусто)" : token, () => {
      assertThrows(() => parseRangeToken(token), UsageError);
    });
  }
});

Deno.test("prefixRangeToken: только диапазоны без «!»", async (t) => {
  const cases: readonly (readonly [string, string, string])[] = [
    ["A1:B2", "Данные", "Данные!A1:B2"],
    ["A1", "My Sheet", "'My Sheet'!A1"],
    ["A1", "O'Hara", "'O''Hara'!A1"],
    ["A1", "wat!", "'wat!'!A1"],
    ["Данные!A1", "Другой", "Данные!A1"],
    ["'S какой-то'!A1", "Другой", "'S какой-то'!A1"],
  ];
  for (const [token, sheet, expected] of cases) {
    await t.step(`${token} + ${sheet}`, () => {
      assertEquals(prefixRangeToken(token, sheet), expected);
    });
  }
});

Deno.test("resolveArea: нормализация и клэмп открытых границ", async (t) => {
  interface Case {
    readonly name: string;
    readonly area: AreaRef;
    readonly rows: number;
    readonly cols: number;
    readonly expected: readonly [number, number, number, number] | null;
  }
  const cases: readonly Case[] = [
    {
      name: "полный диапазон как есть",
      area: { startCol: 1, startRow: 1, endCol: 3, endRow: 3 },
      rows: 6,
      cols: 3,
      expected: [1, 1, 3, 3],
    },
    {
      name: "реверс нормализуется в A1:B2",
      area: { startCol: 2, startRow: 2, endCol: 1, endRow: 1 },
      rows: 6,
      cols: 3,
      expected: [1, 1, 2, 2],
    },
    {
      name: "смешанный реверс B1:A2 — по осям",
      area: { startCol: 2, startRow: 1, endCol: 1, endRow: 2 },
      rows: 6,
      cols: 3,
      expected: [1, 1, 2, 2],
    },
    {
      name: "A5:A на листе из 3 строк — строка 5..5",
      area: { startCol: 1, startRow: 5, endCol: 1, endRow: undefined },
      rows: 3,
      cols: 3,
      expected: [1, 5, 1, 5],
    },
    {
      name: "A:A клэмпится к строкам листа",
      area: { startCol: 1, endCol: 1 },
      rows: 6,
      cols: 3,
      expected: [1, 1, 1, 6],
    },
    {
      name: "1:5 клэмпится к колонкам листа",
      area: { startRow: 1, endRow: 5 },
      rows: 6,
      cols: 3,
      expected: [1, 1, 3, 5],
    },
    {
      name: "весь лист",
      area: {},
      rows: 6,
      cols: 3,
      expected: [1, 1, 3, 6],
    },
    {
      name: "весь пустой лист — пусто",
      area: {},
      rows: 0,
      cols: 0,
      expected: null,
    },
    {
      name: "A:A на листе без строк — пусто",
      area: { startCol: 1, endCol: 1 },
      rows: 0,
      cols: 0,
      expected: null,
    },
    {
      name: "1:5 на листе без колонок — пусто",
      area: { startRow: 1, endRow: 5 },
      rows: 0,
      cols: 0,
      expected: null,
    },
  ];
  for (const c of cases) {
    await t.step(c.name, () => {
      const got = resolveArea(c.area, c.rows, c.cols);
      if (c.expected === null) assertEquals(got, null);
      else {
        const [startCol, startRow, endCol, endRow] = c.expected;
        assertEquals(got, { startCol, startRow, endCol, endRow });
      }
    });
  }
});

Deno.test("colLetters/parseColLetters: границы и обратимость", () => {
  const pairs: readonly (readonly [number, string])[] = [
    [1, "A"],
    [26, "Z"],
    [27, "AA"],
    [702, "ZZ"],
    [703, "AAA"],
    [16384, "XFD"],
  ];
  for (const [num, letters] of pairs) {
    assertEquals(colLetters(num), letters);
    assertEquals(parseColLetters(letters), num);
  }
  assertEquals(parseColLetters("xfd"), 16384);
  assertEquals(parseColLetters("XFE"), null);
  assertEquals(cellName(2, 3), "B3");
});
