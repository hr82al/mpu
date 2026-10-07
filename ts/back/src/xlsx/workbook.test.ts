import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { rejected, thrown } from "@mpu/testing/thrown";
import {
  type Cell,
  cellKey,
  findSheet,
  parseWorkbook,
  parseWorkbookParts,
  WorkbookError,
} from "./workbook.ts";

const encoder = new TextEncoder();

async function sampleBytes(): Promise<Uint8Array> {
  const b64 = await readFile(
    new URL("testdata/sample.xlsx.b64", import.meta.url),
    "utf8",
  );
  return Uint8Array.from(
    atob(b64.replaceAll(/\s+/g, "")),
    (ch) => ch.codePointAt(0)!,
  );
}

/** Минимальная книга из одного листа с данным телом worksheet-XML. */
function oneSheetParts(sheetXml: string): Map<string, Uint8Array> {
  const parts: Record<string, string> = {
    "xl/workbook.xml":
      `<workbook><sheets>` +
      `<sheet name="Лист" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels":
      `<Relationships>` +
      `<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>` +
      `</Relationships>`,
    "xl/worksheets/sheet1.xml": sheetXml,
  };
  return new Map(
    Object.entries(parts).map(([name, xml]) => [name, encoder.encode(xml)]),
  );
}

function cellAt(
  parts: Map<string, Uint8Array>,
  addrCol: number,
  addrRow: number,
): Cell | undefined {
  const wb = parseWorkbookParts(parts);
  return wb.sheets[0].cells.get(cellKey(addrCol, addrRow));
}

it("parseWorkbook: sample.xlsx — листы и типизация", async () => {
  const wb = await parseWorkbook(await sampleBytes());
  expect(
    wb.sheets.map((s) => [s.title, s.index, s.rows, s.cols]),
  ).toStrictEqual([
    ["Данные", 0, 6, 3],
    ["Пустой", 1, 0, 0],
  ]);
  const data = findSheet(wb, "Данные")!;
  const get = (col: number, row: number) => data.cells.get(cellKey(col, row));
  expect(get(1, 1)).toStrictEqual({ value: "товар" });
  expect(get(1, 2)).toStrictEqual({ value: "молоко" });
  expect(get(2, 2)).toStrictEqual({ value: 42 });
  expect(get(3, 2)).toStrictEqual({ value: true });
  expect(get(1, 3)).toStrictEqual({ value: "хлеб" });
  expect(get(2, 3)).toStrictEqual({ value: 3.5 });
  expect(get(3, 3)).toStrictEqual({ value: false });
  expect(get(1, 4)).toStrictEqual({ value: 84, formula: "=B2*2" });
  expect(get(1, 5)).toStrictEqual({ value: "#DIV/0!" });
  expect(get(1, 6)).toStrictEqual({ value: "объединено" });
  // merge A6:B6: копия якоря без формулы, за пределами области пусто
  expect(get(2, 6)).toStrictEqual({ value: "объединено" });
  expect(get(3, 6)).toStrictEqual(undefined);
  expect(findSheet(wb, "данные"), "поиск регистрозависим").toStrictEqual(
    undefined,
  );
});

it("parseWorkbookParts: без координат — последовательно", () => {
  const parts = oneSheetParts(
    `<worksheet><sheetData>` +
      `<row><c><v>1</v></c><c><v>2</v></c></row>` +
      `<row r="5"><c r="B5"><v>3</v></c><c><v>4</v></c></row>` +
      `</sheetData></worksheet>`,
  );
  const wb = parseWorkbookParts(parts);
  const sheet = wb.sheets[0];
  expect(sheet.cells.get(cellKey(1, 1))).toStrictEqual({ value: 1 });
  expect(sheet.cells.get(cellKey(2, 1))).toStrictEqual({ value: 2 });
  expect(sheet.cells.get(cellKey(2, 5))).toStrictEqual({ value: 3 });
  expect(sheet.cells.get(cellKey(3, 5))).toStrictEqual({ value: 4 });
  expect([sheet.rows, sheet.cols]).toStrictEqual([5, 3]);
});

it("parseWorkbookParts: merge и его граничные случаи", () => {
  const parts = oneSheetParts(
    `<worksheet><sheetData>` +
      `<row r="1"><c r="A1" t="str"><v>x</v></c><c r="B1"><v>7</v></c></row>` +
      `</sheetData>` +
      `<mergeCells count="2">` +
      `<mergeCell ref="A1:C1"/>` +
      `<mergeCell ref="D4:E4"/>` + // якоря D4 нет — игнор
      `</mergeCells></worksheet>`,
  );
  const wb = parseWorkbookParts(parts);
  const sheet = wb.sheets[0];
  expect(sheet.cells.get(cellKey(2, 1)), "явная цела").toStrictEqual({
    value: 7,
  });
  expect(sheet.cells.get(cellKey(3, 1)), "копия якоря").toStrictEqual({
    value: "x",
  });
  expect(sheet.cells.get(cellKey(4, 4)), "merge без якоря").toStrictEqual(
    undefined,
  );
  expect([sheet.rows, sheet.cols]).toStrictEqual([1, 3]);
});

describe("parseWorkbookParts: пустые и нечисловые значения", () => {
  const cases: readonly (readonly [string, string, Cell | undefined])[] = [
    ["пустая c", `<c r="A1"/>`, { value: null }],
    ["пустой v", `<c r="A1"><v></v></c>`, { value: null }],
    ["нечисловой raw", `<c r="A1"><v>abc</v></c>`, { value: "abc" }],
    ["int", `<c r="A1"><v>42</v></c>`, { value: 42 }],
    ["float", `<c r="A1"><v>3.5</v></c>`, { value: 3.5 }],
    ["экспонента", `<c r="A1"><v>1e3</v></c>`, { value: 1000 }],
    ["bool true", `<c r="A1" t="b"><v>1</v></c>`, { value: true }],
    ["bool false", `<c r="A1" t="b"><v>0</v></c>`, { value: false }],
    ["ошибка", `<c r="A1" t="e"><v>#NAME?</v></c>`, { value: "#NAME?" }],
    [
      "str-результат",
      `<c r="A1" t="str"><v>текст</v></c>`,
      {
        value: "текст",
      },
    ],
    [
      "inline rich text",
      `<c r="A1" t="inlineStr"><is><r><t>х</t></r>` +
        `<r><t>леб</t></r></is></c>`,
      { value: "хлеб" },
    ],
  ];
  for (const [name, cellXml, expected] of cases) {
    it(name, () => {
      const parts = oneSheetParts(
        `<worksheet><sheetData><row r="1">${cellXml}</row>` +
          `</sheetData></worksheet>`,
      );
      expect(cellAt(parts, 1, 1)).toStrictEqual(expected);
    });
  }
});

it("parseWorkbookParts: shared-формула только у якоря", () => {
  const parts = oneSheetParts(
    `<worksheet><sheetData>` +
      `<row r="1"><c r="A1"><f t="shared" ref="A1:A2" si="0">X1*2</f>` +
      `<v>2</v></c></row>` +
      `<row r="2"><c r="A2"><f t="shared" si="0"/><v>4</v></c></row>` +
      `</sheetData></worksheet>`,
  );
  const wb = parseWorkbookParts(parts);
  const sheet = wb.sheets[0];
  expect(sheet.cells.get(cellKey(1, 1))).toStrictEqual({
    value: 2,
    formula: "=X1*2",
  });
  expect(sheet.cells.get(cellKey(1, 2))).toStrictEqual({ value: 4 });
});

it("parseWorkbookParts: фонетические rPh не входят в текст", () => {
  const phonetic =
    `<si><r><t>漢字</t></r>` + `<rPh sb="0" eb="2"><t>カンジ</t></rPh></si>`;
  const parts = oneSheetParts(
    `<worksheet><sheetData><row r="1">` +
      `<c r="A1" t="s"><v>0</v></c>` +
      `<c r="B1" t="inlineStr"><is><r><t>漢字</t></r>` +
      `<rPh sb="0" eb="2"><t>カンジ</t></rPh></is></c>` +
      `</row></sheetData></worksheet>`,
  );
  parts.set("xl/sharedStrings.xml", encoder.encode(`<sst>${phonetic}</sst>`));
  const sheet = parseWorkbookParts(parts).sheets[0];
  expect(sheet.cells.get(cellKey(1, 1))).toStrictEqual({ value: "漢字" });
  expect(sheet.cells.get(cellKey(2, 1))).toStrictEqual({ value: "漢字" });
});

it("parseWorkbookParts: сущности в общих строках раскрыты", () => {
  const parts = new Map([
    [
      "xl/workbook.xml",
      encoder.encode(
        `<workbook><sheets><sheet name="Л" r:id="rId1"/></sheets></workbook>`,
      ),
    ],
    [
      "xl/_rels/workbook.xml.rels",
      encoder.encode(
        `<Relationships><Relationship Id="rId1" ` +
          `Target="worksheets/sheet1.xml"/></Relationships>`,
      ),
    ],
    [
      "xl/sharedStrings.xml",
      encoder.encode(`<sst><si><t>a &amp; b</t></si></sst>`),
    ],
    [
      "xl/worksheets/sheet1.xml",
      encoder.encode(
        `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c>` +
          `</row></sheetData></worksheet>`,
      ),
    ],
  ]);
  expect(
    parseWorkbookParts(parts).sheets[0].cells.get(cellKey(1, 1)),
  ).toStrictEqual({
    value: "a & b",
  });
});

describe("parseWorkbook/Parts: ошибки формата", () => {
  it("не zip", async () => {
    await rejected(
      () => parseWorkbook(encoder.encode("это не архив")),
      WorkbookError,
      "not a zip archive",
    );
  });
  it("нет xl/workbook.xml", () => {
    thrown(
      () => parseWorkbookParts(new Map()),
      WorkbookError,
      "missing xl/workbook.xml",
    );
  });
  it("битый XML листа", () => {
    const parts = oneSheetParts(`<worksheet><sheetData>`);
    thrown(() => parseWorkbookParts(parts), WorkbookError, "malformed XML:");
  });
  it("нет части листа", () => {
    const parts = oneSheetParts(`<worksheet><sheetData/></worksheet>`);
    parts.delete("xl/worksheets/sheet1.xml");
    thrown(
      () => parseWorkbookParts(parts),
      WorkbookError,
      `missing worksheet part for sheet "Лист"`,
    );
  });
});
