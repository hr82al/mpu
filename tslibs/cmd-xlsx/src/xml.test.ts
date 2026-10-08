import { describe, expect, it } from "vitest";
import { thrown } from "@mpu/testing/thrown";
import {
  attr,
  children,
  firstChild,
  parseXml,
  textContent,
  XmlError,
} from "./xml.ts";

it("parseXml: декларация, атрибуты, самозакрытие, текст", () => {
  const root = parseXml(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<row r="2" spans="1:3"><c r="A2"/><v>42</v></row>`,
  );
  expect(root.name).toBe("row");
  expect(root.attrs.get("r")).toBe("2");
  expect(root.attrs.get("spans")).toBe("1:3");
  expect(children(root, "c").length).toBe(1);
  expect(textContent(firstChild(root, "v")!)).toBe("42");
});

it("parseXml: сущности в тексте и атрибутах", () => {
  const root = parseXml(`<t a="&lt;x&gt; &quot;y&quot; &apos;">a &amp; b</t>`);
  expect(root.attrs.get("a")).toBe(`<x> "y" '`);
  expect(textContent(root)).toBe("a & b");
});

it("parseXml: числовые сущности — десятичные и hex", () => {
  const root = parseXml(`<t>&#1090;&#x430;&#x44A;</t>`);
  expect(textContent(root)).toBe("таъ");
});

it("parseXml: префиксы отброшены, атрибуты по локальному имени", () => {
  const root = parseXml(
    `<x:sheet xmlns:x="ns" xmlns:r="ns2" name="Данные" r:id="rId1"/>`,
  );
  expect(root.name).toBe("sheet");
  expect(attr(root, "id")).toBe("rId1");
  expect(attr(root, "name")).toBe("Данные");
  expect(attr(root, "нет")).toStrictEqual(undefined);
});

it("parseXml: комментарии пропускаются, CDATA — текст", () => {
  const root = parseXml(
    `<!-- шапка --><t><!-- внутри --><![CDATA[a < b & c]]></t><!-- хвост -->`,
  );
  expect(textContent(root)).toBe("a < b & c");
});

it("parseXml: CRLF и CR нормализуются в LF, &#xD; — нет", () => {
  const root = parseXml("<t>a\r\nb\rc &#xD;</t>");
  expect(textContent(root)).toBe("a\nb\nc \r");
});

it("parseXml: числовая сущность с ведущими нулями", () => {
  expect(textContent(parseXml("<t>&#00000000065;</t>"))).toBe("A");
});

it("parseXml: пробельный текст сохраняется буквально", () => {
  const root = parseXml(`<t xml:space="preserve">  два  пробела </t>`);
  expect(textContent(root)).toBe("  два  пробела ");
  expect(attr(root, "space")).toBe("preserve");
});

it("parseXml: rich text склеивается по вложенным t", () => {
  const root = parseXml(`<is><r><t>х</t></r><r><t>леб</t></r></is>`);
  expect(textContent(root)).toBe("хлеб");
});

describe("parseXml: битый документ — XmlError с деталями", () => {
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
    it(name, () => {
      thrown(() => parseXml(xml), XmlError, detail);
    });
  }
});
