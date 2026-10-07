/**
 * Лексика мини-языка (`docs/specs/sheet-batch.md`, «Инструкции»):
 * деление на инструкции и на токены.
 */

import { expect, it } from "vitest";
import { UsageError } from "../command/mod.ts";
import { isQuoted, splitScript, tokenize, unquote } from "./script.ts";

const texts = (source: string) => splitScript(source).map((i) => i.text);

it("разделители — перевод строки и ';' на глубине 0", () => {
  expect(texts("a 1\nb 2; c 3")).toStrictEqual(["a 1", "b 2", "c 3"]);
});

it("';' внутри скобок инструкцию не делит", () => {
  expect(texts('set A1 = =IF(A2>1;"да";"нет")')).toStrictEqual([
    'set A1 = =IF(A2>1;"да";"нет")',
  ]);
  expect(texts("@kind { a: 1; b: 2 }\nnext")).toStrictEqual([
    "@kind { a: 1; b: 2 }",
    "next",
  ]);
});

it("лишняя закрывающая скобка не уводит глубину ниже нуля", () => {
  // Иначе следующая ';' считалась бы «внутри скобок» и склеила бы две
  // инструкции в одну.
  expect(texts("a ); b")).toStrictEqual(["a )", "b"]);
});

it("'#' комментирует до конца строки только на границе токена", () => {
  expect(texts("label A1 x bg=#fff # хвост\nb")).toStrictEqual([
    "label A1 x bg=#fff",
    "b",
  ]);
  expect(texts("# всё\n# и это")).toStrictEqual([]);
});

it("кавычки защищают ';', '#' и перевод строки", () => {
  expect(texts("note A1 'a; b # c'\nd")).toStrictEqual([
    "note A1 'a; b # c'",
    "d",
  ]);
  expect(texts("note A1 'две\nстроки'")).toStrictEqual([
    "note A1 'две\nстроки'",
  ]);
});

it("пустые инструкции отбрасываются, номера идут по оставшимся", () => {
  const parsed = splitScript("a;;\n\n b ");
  expect(parsed.map((i) => [i.text, i.line])).toStrictEqual([["a", 1], [
    "b",
    2,
  ]]);
});

it("токены делятся пробелами, кавычки остаются в токене", () => {
  expect(tokenize("label A1 'два слова' bold")).toStrictEqual([
    "label",
    "A1",
    "'два слова'",
    "bold",
  ]);
});

it("токен, начатый '{', — цельный сбалансированный блок", () => {
  expect(tokenize('@kind { "a": {"b": 1}, "c": "}" }')).toStrictEqual([
    "@kind",
    '{ "a": {"b": 1}, "c": "}" }',
  ]);
});

it("незакрытый блок — ошибка ввода, а не молчаливый хвост", () => {
  expect(() => tokenize("@kind { a: 1")).toThrow(UsageError);
  expect(() => tokenize("@kind { a: 1")).toThrow("незакрытый блок");
});

it("кавычки снимаются только там, где ждут строку", () => {
  expect(unquote("'5'")).toBe("5");
  expect(unquote('"a\\"b"')).toBe('a"b');
  expect(unquote("5")).toBe("5");
  expect(isQuoted("'5'")).toBe(true);
  expect(isQuoted("5")).toBe(false);
});
