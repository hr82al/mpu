/**
 * Лексика мини-языка (`docs/specs/sheet-batch.md`, «Инструкции»):
 * деление на инструкции и на токены.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { UsageError } from "../command/mod.ts";
import { isQuoted, splitScript, tokenize, unquote } from "./script.ts";

const texts = (source: string) => splitScript(source).map((i) => i.text);

Deno.test("разделители — перевод строки и ';' на глубине 0", () => {
  assertEquals(texts("a 1\nb 2; c 3"), ["a 1", "b 2", "c 3"]);
});

Deno.test("';' внутри скобок инструкцию не делит", () => {
  assertEquals(texts('set A1 = =IF(A2>1;"да";"нет")'), [
    'set A1 = =IF(A2>1;"да";"нет")',
  ]);
  assertEquals(texts("@kind { a: 1; b: 2 }\nnext"), [
    "@kind { a: 1; b: 2 }",
    "next",
  ]);
});

Deno.test("лишняя закрывающая скобка не уводит глубину ниже нуля", () => {
  // Иначе следующая ';' считалась бы «внутри скобок» и склеила бы две
  // инструкции в одну.
  assertEquals(texts("a ); b"), ["a )", "b"]);
});

Deno.test("'#' комментирует до конца строки только на границе токена", () => {
  assertEquals(texts("label A1 x bg=#fff # хвост\nb"), [
    "label A1 x bg=#fff",
    "b",
  ]);
  assertEquals(texts("# всё\n# и это"), []);
});

Deno.test("кавычки защищают ';', '#' и перевод строки", () => {
  assertEquals(texts("note A1 'a; b # c'\nd"), ["note A1 'a; b # c'", "d"]);
  assertEquals(texts("note A1 'две\nстроки'"), ["note A1 'две\nстроки'"]);
});

Deno.test("пустые инструкции отбрасываются, номера идут по оставшимся", () => {
  const parsed = splitScript("a;;\n\n b ");
  assertEquals(parsed.map((i) => [i.text, i.line]), [["a", 1], ["b", 2]]);
});

Deno.test("токены делятся пробелами, кавычки остаются в токене", () => {
  assertEquals(tokenize("label A1 'два слова' bold"), [
    "label",
    "A1",
    "'два слова'",
    "bold",
  ]);
});

Deno.test("токен, начатый '{', — цельный сбалансированный блок", () => {
  assertEquals(tokenize('@kind { "a": {"b": 1}, "c": "}" }'), [
    "@kind",
    '{ "a": {"b": 1}, "c": "}" }',
  ]);
});

Deno.test("незакрытый блок — ошибка ввода, а не молчаливый хвост", () => {
  assertThrows(() => tokenize("@kind { a: 1"), UsageError, "незакрытый блок");
});

Deno.test("кавычки снимаются только там, где ждут строку", () => {
  assertEquals(unquote("'5'"), "5");
  assertEquals(unquote('"a\\"b"'), 'a"b');
  assertEquals(unquote("5"), "5");
  assertEquals(isQuoted("'5'"), true);
  assertEquals(isQuoted("5"), false);
});
