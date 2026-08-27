/**
 * A1-диапазоны (`platform/webapp-http.md`): разбор, сборка и границы.
 * Чистые функции — сети и БД здесь нет.
 */

import { assertEquals, assertThrows } from "@std/assert";
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

Deno.test("разбор диапазона: лист, span и весь лист", async (t) => {
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
    await t.step(title, () => assertEquals(parseRange(raw), expected));
  }
});

Deno.test("невалидные диапазоны отбиваются", async (t) => {
  for (const raw of ["", "   ", "Лист!A1:", "Лист!:", "!A1", ":"]) {
    await t.step(`'${raw}'`, () => {
      assertThrows(() => parseRange(raw), BadRangeError);
    });
  }
});

Deno.test("сборка зеркальна разбору", async (t) => {
  const cases = [
    "Sheet1!A1:B2",
    "'Мой лист'!A1",
    "'Лист ''один'''!A1:C3",
    "Sheet1",
  ];
  for (const raw of cases) {
    await t.step(raw, () => assertEquals(formatRange(parseRange(raw)), raw));
  }
});

Deno.test("кавычки ставятся там и только там, где обязательны", () => {
  assertEquals(quoteTab("Sheet1"), "Sheet1");
  assertEquals(quoteTab("wb_unit"), "wb_unit");
  assertEquals(quoteTab("Мой лист"), "'Мой лист'");
  assertEquals(quoteTab("Лист'один"), "'Лист''один'");
});

Deno.test("номера и буквы колонок", () => {
  assertEquals(columnNumber("A"), 1);
  assertEquals(columnNumber("Z"), 26);
  assertEquals(columnNumber("AA"), 27);
  assertEquals(columnLetters(1), "A");
  assertEquals(columnLetters(26), "Z");
  assertEquals(columnLetters(27), "AA");
});

Deno.test("границы span'а: открытые концы закрываются листом", async (t) => {
  await t.step("закрытый span", () => {
    assertEquals(boxOf("A1:B2", 1000, 26), {
      firstRow: 1,
      firstColumn: 1,
      lastRow: 2,
      lastColumn: 2,
    });
  });
  await t.step("колонка целиком", () => {
    assertEquals(boxOf("A:A", 1000, 26), {
      firstRow: 1,
      firstColumn: 1,
      lastRow: 1000,
      lastColumn: 1,
    });
  });
  await t.step("строки целиком", () => {
    assertEquals(boxOf("1:5", 1000, 26), {
      firstRow: 1,
      firstColumn: 1,
      lastRow: 5,
      lastColumn: 26,
    });
  });
  await t.step("весь лист", () => {
    assertEquals(boxOf(undefined, 10, 3), {
      firstRow: 1,
      firstColumn: 1,
      lastRow: 10,
      lastColumn: 3,
    });
  });
});

Deno.test("закрытая форма адреса собирается по границам", () => {
  assertEquals(
    closedAddress("Sheet1", {
      firstRow: 1,
      firstColumn: 1,
      lastRow: 1000,
      lastColumn: 1,
    }),
    "Sheet1!A1:A1000",
  );
  assertEquals(
    closedAddress("Мой лист", {
      firstRow: 2,
      firstColumn: 2,
      lastRow: 3,
      lastColumn: 4,
    }),
    "'Мой лист'!B2:D3",
  );
});
