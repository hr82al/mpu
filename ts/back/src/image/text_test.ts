/**
 * Текст файла метода словами (`image-sync.md`, «Текст → слова»): ровно
 * четыре разделителя, BOM, первый неверный байт UTF-8.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { fileWords, NotUtf8 } from "./text.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

Deno.test("слова: разделители — пробел, табуляция, \\n, \\r; прочие — часть слова", async (t) => {
  const cases: readonly (readonly [string, Uint8Array, readonly string[]])[] = [
    ["пробелы подряд", bytes("a  b"), ["a", "b"]],
    ["табуляция и \\r\\n", bytes("a\tb\r\nc\n"), ["a", "b", "c"]],
    ["неразрывный пробел", bytes("a b c"), ["a b", "c"]],
    ["прочие пробельные", bytes("a b\vc\fd"), ["a b\vc\fd"]],
    [
      "BOM в начале",
      new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("a b")]),
      ["a", "b"],
    ],
    ["пустой файл", new Uint8Array(), []],
  ];
  for (const [name, input, expected] of cases) {
    await t.step(name, () => assertEquals(fileWords(input), expected));
  }
});

Deno.test("не UTF-8: байт и смещение начала неверной последовательности", async (t) => {
  const cases: readonly (readonly [string, readonly number[], string])[] = [
    ["ведущий без продолжения", [0x6b, 0x20, 0xc3, 0x20], "0xC3 на смещении 2"],
    ["оборванный в конце", [0x61, 0xe2, 0x82], "0xE2 на смещении 1"],
    ["продолжение без ведущего", [0x80], "0x80 на смещении 0"],
    ["длинная форма", [0xc0, 0xaf], "0xC0 на смещении 0"],
    ["суррогат", [0xed, 0xa0, 0x80], "0xED на смещении 0"],
    ["за пределом U+10FFFF", [0xf4, 0x90, 0x80, 0x80], "0xF4 на смещении 0"],
  ];
  for (const [name, input, where] of cases) {
    await t.step(name, () => {
      const err = assertThrows(
        () => fileWords(new Uint8Array(input)),
        NotUtf8,
      );
      assertEquals(err.message, `файл не в UTF-8: байт ${where}`);
    });
  }
  await t.step(
    "верные 2-, 3- и 4-байтные",
    () => assertEquals(fileWords(bytes("é € 😀")), ["é", "€", "😀"]),
  );
});
