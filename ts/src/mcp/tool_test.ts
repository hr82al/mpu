/**
 * Усечение описания тула (`platform/mcp-server.md`, «Объём»): предел
 * держит клиент, и молчаливая обрезка на его стороне недопустима.
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { DESCRIPTION_LIMIT, fitDescription } from "./tool.ts";

const utf8 = new TextEncoder();
const PATH = ["code", "refs"] as const;

/** Текст из строк по 40 знаков: длиннее предела и режется по строкам. */
function longText(lines: number): string {
  return Array.from(
    { length: lines },
    (_, i) => `строка ${i} ${"я".repeat(30)}`,
  )
    .join("\n");
}

Deno.test("уложившееся описание не трогается вовсе", () => {
  const short = "однострока\n\nкороткая справка";
  assertEquals(fitDescription(short, PATH), short);
});

Deno.test("описание на самом пределе не усекается", () => {
  // Граница включительна: предел — это то, что клиент ещё держит.
  // Добивается однобайтовыми знаками, а не срезанием: у текста из
  // двухбайтовых перешагнуть предел на единицу нечем.
  const head = longText(20);
  const text = head + "x".repeat(DESCRIPTION_LIMIT - utf8.encode(head).length);
  assertEquals(utf8.encode(text).length, DESCRIPTION_LIMIT);
  assertEquals(fitDescription(text, PATH), text);
});

Deno.test("описание на байт длиннее предела уже усекается", () => {
  const head = longText(20);
  const text = head +
    "x".repeat(DESCRIPTION_LIMIT - utf8.encode(head).length + 1);
  assertEquals(utf8.encode(text).length, DESCRIPTION_LIMIT + 1);
  assertNotEquals(fitDescription(text, PATH), text);
});

Deno.test("длинное описание усекается по границе строки и укладывается", () => {
  const full = longText(200);
  const cut = fitDescription(full, PATH);
  assert(utf8.encode(cut).length <= DESCRIPTION_LIMIT, "усечённое не влезло");
  const lines = cut.split("\n");
  const marker = lines[lines.length - 1];
  // Уцелевшее — целые строки исходника, а не обрывок посреди слова.
  const original = full.split("\n");
  for (const [index, line] of lines.slice(0, -1).entries()) {
    assertEquals(line, original[index], `строка ${index} обрезана`);
  }
  assertStringIncludes(marker, "справка усечена");
  assertStringIncludes(marker, "mpu code refs --help");
});

Deno.test("маркер называет ровно то, чего не досталось читателю", () => {
  const full = longText(200);
  const cut = fitDescription(full, PATH);
  const kept = cut.split("\n").slice(0, -1).join("\n");
  // Ожидаемое берётся от исходного текста, а не той же формулой, что в
  // коде: иначе проверка повторяла бы проверяемое и промах в единицу
  // была бы ей невидима.
  const dropped = full.slice(kept.length + 1);
  assertEquals(
    `${kept}\n${dropped}`,
    full,
    "уцелевшее и отброшенное не сходятся",
  );
  assertStringIncludes(
    cut.split("\n").at(-1) ?? "",
    `отброшено ${utf8.encode(dropped).length} байт`,
  );
});

Deno.test("одна строка длиннее предела — остаётся один маркер", () => {
  // Уцелеть нечему: резать по границе строки не в чем, и молчать об
  // этом нельзя — маркер называет весь отброшенный объём.
  const full = "я".repeat(DESCRIPTION_LIMIT);
  const cut = fitDescription(full, PATH);
  assert(utf8.encode(cut).length <= DESCRIPTION_LIMIT, "маркер не влез");
  assertStringIncludes(cut, `отброшено ${utf8.encode(full).length} байт`);
  assertEquals(cut.split("\n").length, 1);
});

Deno.test("рез приходится на границу абзаца, а не середину", () => {
  // Абзацы по три строки: границы есть, и усечение обязано брать их.
  const paragraph = (n: number) =>
    [0, 1, 2].map((i) => `абзац ${n} строка ${i} ${"я".repeat(20)}`).join("\n");
  const full = Array.from({ length: 40 }, (_, n) => paragraph(n)).join("\n\n");
  const cut = fitDescription(full, PATH);
  const kept = cut.split("\n").slice(0, -1).join("\n");
  assert(
    full.startsWith(`${kept}\n\n`),
    `рез посреди абзаца:\n…${kept.slice(-80)}`,
  );
});
