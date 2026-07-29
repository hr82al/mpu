import { assertEquals } from "@std/assert";
import {
  type OutputCell,
  renderGetJson,
  renderGetRaw,
  renderGetTsv,
  renderLsJson,
  renderLsLong,
  renderLsPlain,
} from "./render.ts";

const cells: readonly OutputCell[] = [
  { range: "Л!A1", value: 84, formula: "=B2*2" },
  { range: "Л!A2", value: "текст" },
  { range: "Л!A3", value: null },
  { range: "Л!A4", value: true },
];

Deno.test("renderGetJson: режимы both/values/formulas", () => {
  assertEquals(
    renderGetJson("/tmp/f.xlsx", cells.slice(0, 2), "both"),
    `{
  "file": "/tmp/f.xlsx",
  "cells": [
    {
      "range": "Л!A1",
      "value": 84,
      "formula": "=B2*2"
    },
    {
      "range": "Л!A2",
      "value": "текст"
    }
  ]
}`,
  );
  assertEquals(
    renderGetJson("/f", cells.slice(0, 1), "values"),
    `{
  "file": "/f",
  "cells": [
    {
      "range": "Л!A1",
      "value": 84
    }
  ]
}`,
  );
  assertEquals(
    renderGetJson("/f", cells.slice(0, 2), "formulas"),
    `{
  "file": "/f",
  "cells": [
    {
      "range": "Л!A1",
      "formula": "=B2*2"
    },
    {
      "range": "Л!A2"
    }
  ]
}`,
  );
});

Deno.test("renderGetTsv: шапка, строковый рендер, экранирование", () => {
  assertEquals(
    renderGetTsv(cells, "both"),
    "range\tvalue\tformula\n" +
      "Л!A1\t84\t=B2*2\n" +
      "Л!A2\tтекст\t\n" +
      "Л!A3\t\t\n" +
      "Л!A4\tTrue\t\n",
  );
  assertEquals(
    renderGetTsv(cells.slice(2), "values"),
    "range\tvalue\n" + "Л!A3\t\n" + "Л!A4\tTrue\n",
  );
  assertEquals(
    renderGetTsv(cells.slice(0, 2), "formulas"),
    "range\tformula\n" + "Л!A1\t=B2*2\n" + "Л!A2\t\n",
  );
  assertEquals(
    renderGetTsv(
      [{ range: "Л!B1", value: "a\\b\nc\td\re" }],
      "values",
    ),
    "range\tvalue\n" + "Л!B1\ta\\\\b\\nc\\td\\re\n",
  );
});

Deno.test("renderGetRaw: одна ячейка голая, много — построчно", () => {
  assertEquals(renderGetRaw([{ range: "r", value: 42 }], "both"), "42");
  assertEquals(renderGetRaw([{ range: "r", value: false }], "values"), "False");
  assertEquals(renderGetRaw([{ range: "r", value: null }], "both"), "");
  assertEquals(
    renderGetRaw(cells.slice(0, 2), "both"),
    "84\t=B2*2\nтекст\t\n",
  );
  assertEquals(renderGetRaw(cells.slice(0, 2), "values"), "84\nтекст\n");
  assertEquals(
    renderGetRaw(cells.slice(0, 2), "formulas"),
    "=B2*2\n\n",
  );
  // Сырое значение не экранируется — печатается как есть.
  assertEquals(
    renderGetRaw([{ range: "r", value: "a\tb" }], "values"),
    "a\tb",
  );
});

const sampleSheets = [
  { title: "Данные", index: 0, rows: 6, cols: 3 },
  { title: "Пустой", index: 1, rows: 0, cols: 0 },
];

Deno.test("renderLs*: формы вывода списка листов", () => {
  assertEquals(renderLsPlain(sampleSheets), "Данные\nПустой\n");
  assertEquals(
    renderLsLong(sampleSheets),
    "Данные  6×3  #0\nПустой  0×0  #1\n",
  );
  assertEquals(
    renderLsJson(sampleSheets),
    `[
  {
    "title": "Данные",
    "index": 0,
    "rows": 6,
    "cols": 3
  },
  {
    "title": "Пустой",
    "index": 1,
    "rows": 0,
    "cols": 0
  }
]`,
  );
});

Deno.test("renderLsLong: ширины по code points, cols вправо", () => {
  const sheets = [
    { title: "AB", index: 0, rows: 1, cols: 10 },
    { title: "Я", index: 1, rows: 5, cols: 3 },
  ];
  assertEquals(renderLsLong(sheets), "AB  1×10  #0\nЯ   5× 3  #1\n");
});
