/**
 * Текст словами (`image-sync.md`, «Текст → слова»; `program-input.md`):
 * ровно четыре разделителя, BOM, первый неверный байт UTF-8, строка без
 * слов.
 */

import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import {
  ASK_WORD,
  hasSeparator,
  isBareLine,
  NotUtf8,
  utf8Of,
  wordsOf,
} from "./words.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

/** Слова байтов тем же путём, что у файла и у ввода. */
const wordsOfBytes = (input: Uint8Array) => wordsOf(utf8Of(input));

Deno.test("слова: разделители — пробел, табуляция, \\n, \\r; прочие — часть слова", async (t) => {
  const cases: readonly (readonly [string, Uint8Array, readonly string[]])[] = [
    ["пробелы подряд", bytes("a  b"), ["a", "b"]],
    ["табуляция и \\r\\n", bytes("a\tb\r\nc\n"), ["a", "b", "c"]],
    ["неразрывный пробел", bytes("a\u00a0b c"), ["a\u00a0b", "c"]],
    ["прочие пробельные", bytes("a\u2003b\vc\fd"), ["a\u2003b\vc\fd"]],
    [
      "BOM в начале",
      new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("a b")]),
      ["a", "b"],
    ],
    [
      "BOM и только разделители",
      new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(" \r\n\t")]),
      [],
    ],
    ["пустой файл", new Uint8Array(), []],
  ];
  for (const [name, input, expected] of cases) {
    await t.step(name, () => assertEquals(wordsOfBytes(input), expected));
  }
});

Deno.test("BOM снимают слова, а не декодер: у текста строкой — тот же", async (t) => {
  await t.step("utf8Of оставляет BOM", () => {
    const text = utf8Of(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("a")]));
    assertEquals(text, "\ufeffa");
  });
  await t.step("wordsOf снимает U+FEFF в начале", () => {
    assertEquals(wordsOf("\ufeff^готово к ревью^ print\r\n"), [
      "^готово",
      "к",
      "ревью^",
      "print",
    ]);
  });
  await t.step("U+FEFF не в начале — часть слова", () => {
    assertEquals(wordsOf("a \ufeffb"), ["a", "\ufeffb"]);
  });
});

Deno.test("не UTF-8: байт и смещение начала неверной последовательности", async (t) => {
  const cases: readonly (readonly [string, readonly number[], string])[] = [
    ["ведущий без продолжения", [0x6b, 0x20, 0xc3, 0x20], "0xC3 на смещении 2"],
    ["оборванный в конце", [0x61, 0xe2, 0x82], "0xE2 на смещении 1"],
    ["продолжение без ведущего", [0x80], "0x80 на смещении 0"],
    ["длинная форма", [0xc0, 0xaf], "0xC0 на смещении 0"],
    ["суррогат", [0xed, 0xa0, 0x80], "0xED на смещении 0"],
    ["за пределом U+10FFFF", [0xf4, 0x90, 0x80, 0x80], "0xF4 на смещении 0"],
    [
      "смещение считает BOM",
      [0xef, 0xbb, 0xbf, 0x5e, 0xc3],
      "0xC3 на смещении 4",
    ],
  ];
  for (const [name, input, where] of cases) {
    await t.step(name, () => {
      const err = assertThrows(
        () => utf8Of(new Uint8Array(input)),
        NotUtf8,
      );
      assertEquals(err.message, `не в UTF-8: байт ${where}`);
    });
  }
  await t.step(
    "верные 2-, 3- и 4-байтные",
    () => assertEquals(wordsOfBytes(bytes("é € 😀")), ["é", "€", "😀"]),
  );
});

Deno.test("слово с разделителем — ровно четыре знака, U+00A0 не разделитель", async (t) => {
  const cases: readonly (readonly [string, boolean])[] = [
    ["a b", true],
    ["a\tb", true],
    ["a\nb", true],
    ["a\rb", true],
    ["a\u00a0b", false],
    ["a\u2003b", false],
    ["ab", false],
  ];
  for (const [word, expected] of cases) {
    await t.step(JSON.stringify(word), () => {
      assertEquals(hasSeparator(word), expected);
    });
  }
});

Deno.test("строка без слов — пусто или одно ask", async (t) => {
  await t.step("пусто", () => assert(isBareLine([])));
  await t.step("ask", () => assert(isBareLine([ASK_WORD])));
  await t.step("ask и слово", () => assertFalse(isBareLine([ASK_WORD, "x"])));
  await t.step("слово", () => assertFalse(isBareLine(["version"])));
  await t.step("--json", () => assertFalse(isBareLine(["--json"])));
});
