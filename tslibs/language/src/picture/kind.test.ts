/**
 * Вид картинки по первым байтам файла — таблица «Вид картинки — по
 * байтам» `platform/picture-frame.md`. `mime` от Telegram в разбор не
 * входит вовсе: строки таблицы с ним проверяют, что он и не нужен.
 */

import { describe, expect, it } from "vitest";
import { kindOf } from "./kind.ts";

const ascii = (text: string) => [...new TextEncoder().encode(text)];

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...ascii("JFIF")];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00];
const GIF87 = [...ascii("GIF87a"), 0x01, 0x00, 0x01, 0x00];
const GIF89 = [...ascii("GIF89a"), 0x01, 0x00, 0x01, 0x00];
const WEBP = [...ascii("RIFF"), 0x0c, 0, 0, 0, ...ascii("WEBPVP8 ")];
const WAVE = [...ascii("RIFF"), 0x0c, 0, 0, 0, ...ascii("WAVEfmt ")];

/** Что разбор отдал получателю: вид или ничего. */
function shown(bytes: readonly number[]): string | null {
  const taken: string[] = [];
  kindOf(new Uint8Array(bytes)).offer(new Uint8Array(bytes), {
    take: (mime) => void taken.push(mime),
  });
  return taken[0] ?? null;
}

describe("вид картинки — по байтам, mime Telegram не решает", () => {
  const cases: [string, readonly number[], string | null][] = [
    ["FF D8 FF / image/jpeg", JPEG, "image/jpeg"],
    ["FF D8 FF / application/octet-stream", JPEG, "image/jpeg"],
    ["PNG / image/png", PNG, "image/png"],
    ["GIF87a / image/gif", GIF87, "image/gif"],
    ["GIF89a / image/gif", GIF89, "image/gif"],
    ["RIFF…WEBP / image/webp", WEBP, "image/webp"],
    ["RIFF…WEBP / image/jpeg", WEBP, "image/webp"],
    ["GIF89a / image/png", GIF89, "image/gif"],
    ["RIFF…WAVE / audio/wav", WAVE, null],
    [
      "<svg / image/svg+xml",
      ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      null,
    ],
    ["<?xml / image/svg+xml", ascii('<?xml version="1.0"?>'), null],
    ["ftypheic / image/heic", [0, 0, 0, 0x18, ...ascii("ftypheic")], null],
    ["TIFF / image/tiff", [0x49, 0x49, 0x2a, 0x00, 1, 2], null],
    ["BMP / image/bmp", [0x42, 0x4d, 1, 2, 3], null],
    ["# не картинка / image/png", ascii("# не картинка"), null],
    ["FF D8 — короче подписи / image/jpeg", [0xff, 0xd8], null],
    ["пустой файл / image/jpeg", [], null],
  ];
  for (const [name, bytes, mime] of cases) {
    it(name, () => expect(shown(bytes)).toStrictEqual(mime));
  }
});
