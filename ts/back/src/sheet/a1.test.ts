/**
 * A1-диапазоны (`platform/webapp-http.md`): разбор, сборка и границы.
 * Чистые функции — сети и БД здесь нет.
 */

import { describe, expect, it } from "vitest";
import {
  BadRangeError,
  boxOf,
  closedAddress,
  columnLetters,
  columnNumber,
  formatRange,
  parseRange,
  quoteTab,
} from "./a1.ts";

describe("разбор диапазона: лист, span и весь лист", () => {
  const cases: readonly (readonly [string, string, unknown])[] = [
    ["лист и span", "Sheet1!A1:B2", { tab: "Sheet1", span: "A1:B2" }],
    ["одна ячейка", "Sheet1!A1", { tab: "Sheet1", span: "A1" }],
    ["открытая колонка", "Sheet1!A:A", { tab: "Sheet1", span: "A:A" }],
    ["открытые строки", "Sheet1!1:5", { tab: "Sheet1", span: "1:5" }],
    ["весь лист именем", "Отчёт", { tab: "Отчёт" }],
    ["весь лист с '!'", "Отчёт!", { tab: "Отчёт" }],
    ["имя в кавычках", "'Мой лист'!A1", { tab: "Мой лист", span: "A1" }],
    ["кавычка внутри имени", "'Лист ''один'''!A1", {
      tab: "Лист 'один'",
      span: "A1",
    }],
    ["span без листа", "A1:B2", { span: "A1:B2" }],
    ["ссылка на ячейку без листа", "B2", { span: "B2" }],
  ];
  for (const [title, raw, expected] of cases) {
    it(title, () => expect(parseRange(raw)).toStrictEqual(expected));
  }
});

describe("невалидные диапазоны отбиваются", () => {
  for (const raw of ["", "   ", "Лист!A1:", "Лист!:", "!A1", ":"]) {
    it(`'${raw}'`, () => {
      expect(() => parseRange(raw)).toThrow(BadRangeError);
    });
  }
});

describe("сборка зеркальна разбору", () => {
  const cases = [
    "Sheet1!A1:B2",
    "'Мой лист'!A1",
    "'Лист ''один'''!A1:C3",
    "Sheet1",
  ];
  for (const raw of cases) {
    it(raw, () => expect(formatRange(parseRange(raw))).toStrictEqual(raw));
  }
});

it("кавычки ставятся там и только там, где обязательны", () => {
  expect(quoteTab("Sheet1")).toBe("Sheet1");
  expect(quoteTab("wb_unit")).toBe("wb_unit");
  expect(quoteTab("Мой лист")).toBe("'Мой лист'");
  expect(quoteTab("Лист'один")).toBe("'Лист''один'");
});

it("номера и буквы колонок", () => {
  expect(columnNumber("A")).toBe(1);
  expect(columnNumber("Z")).toBe(26);
  expect(columnNumber("AA")).toBe(27);
  expect(columnLetters(1)).toBe("A");
  expect(columnLetters(26)).toBe("Z");
  expect(columnLetters(27)).toBe("AA");
});

describe("границы span'а: открытые концы закрываются листом", () => {
  it("закрытый span", () => {
    expect(boxOf("A1:B2", 1000, 26)).toStrictEqual({
      firstRow: 1,
      firstColumn: 1,
      lastRow: 2,
      lastColumn: 2,
    });
  });
  it("колонка целиком", () => {
    expect(boxOf("A:A", 1000, 26)).toStrictEqual({
      firstRow: 1,
      firstColumn: 1,
      lastRow: 1000,
      lastColumn: 1,
    });
  });
  it("строки целиком", () => {
    expect(boxOf("1:5", 1000, 26)).toStrictEqual({
      firstRow: 1,
      firstColumn: 1,
      lastRow: 5,
      lastColumn: 26,
    });
  });
  it("весь лист", () => {
    expect(boxOf(undefined, 10, 3)).toStrictEqual({
      firstRow: 1,
      firstColumn: 1,
      lastRow: 10,
      lastColumn: 3,
    });
  });
});

it("закрытая форма адреса собирается по границам", () => {
  expect(closedAddress("Sheet1", {
    firstRow: 1,
    firstColumn: 1,
    lastRow: 1000,
    lastColumn: 1,
  })).toBe("Sheet1!A1:A1000");
  expect(closedAddress("Мой лист", {
    firstRow: 2,
    firstColumn: 2,
    lastRow: 3,
    lastColumn: 4,
  })).toBe("'Мой лист'!B2:D3");
});
