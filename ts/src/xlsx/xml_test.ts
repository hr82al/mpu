import { assertEquals, assertThrows } from "@std/assert";
import {
  attr,
  children,
  firstChild,
  parseXml,
  textContent,
  XmlError,
} from "./xml.ts";

Deno.test("parseXml: декларация, атрибуты, самозакрытие, текст", () => {
  const root = parseXml(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<row r="2" spans="1:3"><c r="A2"/><v>42</v></row>`,
  );
  assertEquals(root.name, "row");
  assertEquals(root.attrs.get("r"), "2");
  assertEquals(root.attrs.get("spans"), "1:3");
  assertEquals(children(root, "c").length, 1);
  assertEquals(textContent(firstChild(root, "v")!), "42");
});

Deno.test("parseXml: сущности в тексте и атрибутах", () => {
  const root = parseXml(`<t a="&lt;x&gt; &quot;y&quot; &apos;">a &amp; b</t>`);
  assertEquals(root.attrs.get("a"), `<x> "y" '`);
  assertEquals(textContent(root), "a & b");
});

Deno.test("parseXml: числовые сущности — десятичные и hex", () => {
  const root = parseXml(`<t>&#1090;&#x430;&#x44A;</t>`);
  assertEquals(textContent(root), "таъ");
});

Deno.test("parseXml: префиксы отброшены, атрибуты по локальному имени", () => {
  const root = parseXml(
    `<x:sheet xmlns:x="ns" xmlns:r="ns2" name="Данные" r:id="rId1"/>`,
  );
  assertEquals(root.name, "sheet");
  assertEquals(attr(root, "id"), "rId1");
  assertEquals(attr(root, "name"), "Данные");
  assertEquals(attr(root, "нет"), undefined);
});

Deno.test("parseXml: комментарии пропускаются, CDATA — текст", () => {
  const root = parseXml(
    `<!-- шапка --><t><!-- внутри --><![CDATA[a < b & c]]></t><!-- хвост -->`,
  );
  assertEquals(textContent(root), "a < b & c");
});

Deno.test("parseXml: CRLF и CR нормализуются в LF, &#xD; — нет", () => {
  const root = parseXml("<t>a\r\nb\rc &#xD;</t>");
  assertEquals(textContent(root), "a\nb\nc \r");
});

Deno.test("parseXml: числовая сущность с ведущими нулями", () => {
  assertEquals(textContent(parseXml("<t>&#00000000065;</t>")), "A");
});

Deno.test("parseXml: пробельный текст сохраняется буквально", () => {
  const root = parseXml(`<t xml:space="preserve">  два  пробела </t>`);
  assertEquals(textContent(root), "  два  пробела ");
  assertEquals(attr(root, "space"), "preserve");
});

Deno.test("parseXml: rich text склеивается по вложенным t", () => {
  const root = parseXml(`<is><r><t>х</t></r><r><t>леб</t></r></is>`);
  assertEquals(textContent(root), "хлеб");
});

Deno.test("parseXml: битый документ — XmlError с деталями", async (t) => {
  const cases: readonly (readonly [string, string, string])[] = [
    ["незакрытый корень", `<row><c r="A1">`, "unexpected end"],
    ["чужой закрывающий тег", `<row><c></row>`, "mismatched closing tag"],
    ["неизвестная сущность", `<t>&nbsp;</t>`, "entity"],
    ["мусор после корня", `<t/>лишнее`, "after the root"],
    ["атрибут без значения", `<t a></t>`, "="],
    ["незакрытое значение атрибута", `<t a="x></t>`, "unexpected end"],
    ["пустой ввод", ``, "no root element"],
    ["текст вместо документа", `просто текст`, "no root element"],
  ];
  for (const [name, xml, detail] of cases) {
    await t.step(name, () => {
      assertThrows(() => parseXml(xml), XmlError, detail);
    });
  }
});
