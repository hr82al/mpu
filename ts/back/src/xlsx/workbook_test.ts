import { assertEquals, assertRejects, assertThrows } from "@std/assert";
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
  const b64 = await Deno.readTextFile(
    new URL("testdata/sample.xlsx.b64", import.meta.url),
  );
  return Uint8Array.from(
    atob(b64.replaceAll(/\s+/g, "")),
    (ch) => ch.codePointAt(0)!,
  );
}

/** Минимальная книга из одного листа с данным телом worksheet-XML. */
function oneSheetParts(sheetXml: string): Map<string, Uint8Array> {
  const parts: Record<string, string> = {
    "xl/workbook.xml": `<workbook><sheets>` +
      `<sheet name="Лист" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships>` +
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

Deno.test("parseWorkbook: sample.xlsx — листы и типизация", async () => {
  const wb = await parseWorkbook(await sampleBytes());
  assertEquals(
    wb.sheets.map((s) => [s.title, s.index, s.rows, s.cols]),
    [["Данные", 0, 6, 3], ["Пустой", 1, 0, 0]],
  );
  const data = findSheet(wb, "Данные")!;
  const get = (col: number, row: number) => data.cells.get(cellKey(col, row));
  assertEquals(get(1, 1), { value: "товар" });
  assertEquals(get(1, 2), { value: "молоко" });
  assertEquals(get(2, 2), { value: 42 });
  assertEquals(get(3, 2), { value: true });
  assertEquals(get(1, 3), { value: "хлеб" });
  assertEquals(get(2, 3), { value: 3.5 });
  assertEquals(get(3, 3), { value: false });
  assertEquals(get(1, 4), { value: 84, formula: "=B2*2" });
  assertEquals(get(1, 5), { value: "#DIV/0!" });
  assertEquals(get(1, 6), { value: "объединено" });
  // merge A6:B6: копия якоря без формулы, за пределами области пусто
  assertEquals(get(2, 6), { value: "объединено" });
  assertEquals(get(3, 6), undefined);
  assertEquals(findSheet(wb, "данные"), undefined, "поиск регистрозависим");
});

Deno.test("parseWorkbookParts: без координат — последовательно", () => {
  const parts = oneSheetParts(
    `<worksheet><sheetData>` +
      `<row><c><v>1</v></c><c><v>2</v></c></row>` +
      `<row r="5"><c r="B5"><v>3</v></c><c><v>4</v></c></row>` +
      `</sheetData></worksheet>`,
  );
  const wb = parseWorkbookParts(parts);
  const sheet = wb.sheets[0];
  assertEquals(sheet.cells.get(cellKey(1, 1)), { value: 1 });
  assertEquals(sheet.cells.get(cellKey(2, 1)), { value: 2 });
  assertEquals(sheet.cells.get(cellKey(2, 5)), { value: 3 });
  assertEquals(sheet.cells.get(cellKey(3, 5)), { value: 4 });
  assertEquals([sheet.rows, sheet.cols], [5, 3]);
});

Deno.test("parseWorkbookParts: merge и его граничные случаи", () => {
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
  assertEquals(sheet.cells.get(cellKey(2, 1)), { value: 7 }, "явная цела");
  assertEquals(sheet.cells.get(cellKey(3, 1)), { value: "x" }, "копия якоря");
  assertEquals(sheet.cells.get(cellKey(4, 4)), undefined, "merge без якоря");
  assertEquals([sheet.rows, sheet.cols], [1, 3]);
});

Deno.test("parseWorkbookParts: пустые и нечисловые значения", async (t) => {
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
    ["str-результат", `<c r="A1" t="str"><v>текст</v></c>`, {
      value: "текст",
    }],
    [
      "inline rich text",
      `<c r="A1" t="inlineStr"><is><r><t>х</t></r>` +
      `<r><t>леб</t></r></is></c>`,
      { value: "хлеб" },
    ],
  ];
  for (const [name, cellXml, expected] of cases) {
    await t.step(name, () => {
      const parts = oneSheetParts(
        `<worksheet><sheetData><row r="1">${cellXml}</row>` +
          `</sheetData></worksheet>`,
      );
      assertEquals(cellAt(parts, 1, 1), expected);
    });
  }
});

Deno.test("parseWorkbookParts: shared-формула только у якоря", () => {
  const parts = oneSheetParts(
    `<worksheet><sheetData>` +
      `<row r="1"><c r="A1"><f t="shared" ref="A1:A2" si="0">X1*2</f>` +
      `<v>2</v></c></row>` +
      `<row r="2"><c r="A2"><f t="shared" si="0"/><v>4</v></c></row>` +
      `</sheetData></worksheet>`,
  );
  const wb = parseWorkbookParts(parts);
  const sheet = wb.sheets[0];
  assertEquals(sheet.cells.get(cellKey(1, 1)), { value: 2, formula: "=X1*2" });
  assertEquals(sheet.cells.get(cellKey(1, 2)), { value: 4 });
});

Deno.test("parseWorkbookParts: фонетические rPh не входят в текст", () => {
  const phonetic = `<si><r><t>漢字</t></r>` +
    `<rPh sb="0" eb="2"><t>カンジ</t></rPh></si>`;
  const parts = oneSheetParts(
    `<worksheet><sheetData><row r="1">` +
      `<c r="A1" t="s"><v>0</v></c>` +
      `<c r="B1" t="inlineStr"><is><r><t>漢字</t></r>` +
      `<rPh sb="0" eb="2"><t>カンジ</t></rPh></is></c>` +
      `</row></sheetData></worksheet>`,
  );
  parts.set(
    "xl/sharedStrings.xml",
    encoder.encode(`<sst>${phonetic}</sst>`),
  );
  const sheet = parseWorkbookParts(parts).sheets[0];
  assertEquals(sheet.cells.get(cellKey(1, 1)), { value: "漢字" });
  assertEquals(sheet.cells.get(cellKey(2, 1)), { value: "漢字" });
});

Deno.test("parseWorkbookParts: сущности в общих строках раскрыты", () => {
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
  assertEquals(parseWorkbookParts(parts).sheets[0].cells.get(cellKey(1, 1)), {
    value: "a & b",
  });
});

Deno.test("parseWorkbook/Parts: ошибки формата", async (t) => {
  await t.step("не zip", async () => {
    await assertRejects(
      () => parseWorkbook(encoder.encode("это не архив")),
      WorkbookError,
      "not a zip archive",
    );
  });
  await t.step("нет xl/workbook.xml", () => {
    assertThrows(
      () => parseWorkbookParts(new Map()),
      WorkbookError,
      "missing xl/workbook.xml",
    );
  });
  await t.step("битый XML листа", () => {
    const parts = oneSheetParts(`<worksheet><sheetData>`);
    assertThrows(
      () => parseWorkbookParts(parts),
      WorkbookError,
      "malformed XML:",
    );
  });
  await t.step("нет части листа", () => {
    const parts = oneSheetParts(`<worksheet><sheetData/></worksheet>`);
    parts.delete("xl/worksheets/sheet1.xml");
    assertThrows(
      () => parseWorkbookParts(parts),
      WorkbookError,
      `missing worksheet part for sheet "Лист"`,
    );
  });
});
