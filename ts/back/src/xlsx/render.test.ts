import { expect, it } from "vitest";
import {
  type OutputCell,
  renderGetRaw,
  renderGetTsv,
  renderLsLong,
  renderLsPlain,
} from "./render.ts";

const cells: readonly OutputCell[] = [
  { range: "Л!A1", value: 84, formula: "=B2*2" },
  { range: "Л!A2", value: "текст" },
  { range: "Л!A3", value: null },
  { range: "Л!A4", value: true },
];

it("renderGetTsv: шапка, строковый рендер, экранирование", () => {
  expect(renderGetTsv(cells, "both")).toStrictEqual(
    "range\tvalue\tformula\n" +
      "Л!A1\t84\t=B2*2\n" +
      "Л!A2\tтекст\t\n" +
      "Л!A3\t\t\n" +
      "Л!A4\tTrue\t\n",
  );
  expect(renderGetTsv(cells.slice(2), "values")).toStrictEqual(
    "range\tvalue\n" + "Л!A3\t\n" + "Л!A4\tTrue\n",
  );
  expect(renderGetTsv(cells.slice(0, 2), "formulas")).toStrictEqual(
    "range\tformula\n" + "Л!A1\t=B2*2\n" + "Л!A2\t\n",
  );
  expect(
    renderGetTsv([{ range: "Л!B1", value: "a\\b\nc\td\re" }], "values"),
  ).toStrictEqual("range\tvalue\n" + "Л!B1\ta\\\\b\\nc\\td\\re\n");
});

it("renderGetRaw: одна ячейка голая, много — построчно", () => {
  expect(renderGetRaw([{ range: "r", value: 42 }], "both")).toBe("42");
  expect(renderGetRaw([{ range: "r", value: false }], "values")).toBe("False");
  expect(renderGetRaw([{ range: "r", value: null }], "both")).toBe("");
  expect(renderGetRaw(cells.slice(0, 2), "both")).toBe("84\t=B2*2\nтекст\t\n");
  expect(renderGetRaw(cells.slice(0, 2), "values")).toBe("84\nтекст\n");
  expect(renderGetRaw(cells.slice(0, 2), "formulas")).toBe("=B2*2\n\n");
  // Сырое значение не экранируется — печатается как есть.
  expect(renderGetRaw([{ range: "r", value: "a\tb" }], "values")).toBe("a\tb");
});

const sampleSheets = [
  { title: "Данные", index: 0, rows: 6, cols: 3 },
  { title: "Пустой", index: 1, rows: 0, cols: 0 },
];

it("renderLs*: формы вывода списка листов", () => {
  expect(renderLsPlain(sampleSheets)).toBe("Данные\nПустой\n");
  expect(renderLsLong(sampleSheets)).toBe("Данные  6×3  #0\nПустой  0×0  #1\n");
});

it("renderLsLong: ширины по code points, cols вправо", () => {
  const sheets = [
    { title: "AB", index: 0, rows: 1, cols: 10 },
    { title: "Я", index: 1, rows: 5, cols: 3 },
  ];
  expect(renderLsLong(sheets)).toBe("AB  1×10  #0\nЯ   5× 3  #1\n");
});
