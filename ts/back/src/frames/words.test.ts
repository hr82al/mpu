/**
 * Текст словами (`image-sync.md`, «Текст → слова»; `program-input.md`):
 * ровно четыре разделителя, BOM, первый неверный байт UTF-8, строка без
 * слов.
 */

import { assert, describe, expect, it } from "vitest";
import { thrown } from "../testing/thrown.ts";
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

describe("слова: разделители — пробел, табуляция, \\n, \\r; прочие — часть слова", () => {
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
    it(name, () => expect(wordsOfBytes(input)).toStrictEqual(expected));
  }
});

describe("BOM снимают слова, а не декодер: у текста строкой — тот же", () => {
  it("utf8Of оставляет BOM", () => {
    const text = utf8Of(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("a")]));
    expect(text).toBe("\ufeffa");
  });
  it("wordsOf снимает U+FEFF в начале", () => {
    expect(wordsOf("\ufeff^готово к ревью^ print\r\n")).toStrictEqual([
      "^готово",
      "к",
      "ревью^",
      "print",
    ]);
  });
  it("U+FEFF не в начале — часть слова", () => {
    expect(wordsOf("a \ufeffb")).toStrictEqual(["a", "\ufeffb"]);
  });
});

describe("не UTF-8: байт и смещение начала неверной последовательности", () => {
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
    it(name, () => {
      const err = thrown(() => utf8Of(new Uint8Array(input)), NotUtf8);
      expect(err.message).toStrictEqual(`не в UTF-8: байт ${where}`);
    });
  }
  it("верные 2-, 3- и 4-байтные", () =>
    expect(wordsOfBytes(bytes("é € 😀"))).toStrictEqual(["é", "€", "😀"]));
});

describe("слово с разделителем — ровно четыре знака, U+00A0 не разделитель", () => {
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
    it(JSON.stringify(word), () => {
      expect(hasSeparator(word)).toStrictEqual(expected);
    });
  }
});

describe("строка без слов — пусто или одно ask", () => {
  it("пусто", () => assert(isBareLine([])));
  it("ask", () => assert(isBareLine([ASK_WORD])));
  it("ask и слово", () => expect(isBareLine([ASK_WORD, "x"])).toBeFalsy());
  it("слово", () => expect(isBareLine(["version"])).toBeFalsy());
  it("--json", () => expect(isBareLine(["--json"])).toBeFalsy());
});
