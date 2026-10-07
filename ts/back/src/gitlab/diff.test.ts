/**
 * Разбор unified diff (`platform/gitlab-api.md`): классификация строк,
 * нумерация обеих сторон и счётчики файла.
 */

import { expect, it } from "vitest";
import { countDiff, parseDiffLines } from "./diff.ts";

const SAMPLE = [
  "--- a/src/file.ts",
  "+++ b/src/file.ts",
  "@@ -10,4 +10,5 @@ function f() {",
  " контекст",
  "-старая",
  "+новая",
  "+ещё новая",
  "",
  "\\ No newline at end of file",
  " хвост",
].join("\n");

it("строки диффа: вид, номера сторон и текст", () => {
  expect(parseDiffLines(SAMPLE)).toStrictEqual([
    { kind: "context", oldLine: 10, newLine: 10, text: "контекст" },
    { kind: "removed", oldLine: 11, newLine: undefined, text: "старая" },
    { kind: "added", oldLine: undefined, newLine: 11, text: "новая" },
    { kind: "added", oldLine: undefined, newLine: 12, text: "ещё новая" },
    // Пустая строка — контекст: ведущий пробел теряется по дороге, а
    // неизменённая строка обязана двигать оба номера.
    { kind: "context", oldLine: 12, newLine: 13, text: "" },
    { kind: "context", oldLine: 13, newLine: 14, text: "хвост" },
  ]);
});

it("шапка до первого hunk не считается строками файла", () => {
  // `+++ b/…` — не added-строка: иначе номера правой стороны уехали бы
  // на единицу, и комментарий лёг бы не на ту строку.
  expect(countDiff(SAMPLE)).toStrictEqual({ additions: 2, deletions: 1 });
  expect(parseDiffLines("--- a/x\n+++ b/x\nindex 1..2 100644")).toStrictEqual(
    [],
  );
});

it("несколько hunk'ов: каждый заголовок задаёт свои номера", () => {
  const diff = [
    "@@ -1,2 +1,2 @@",
    "-раз",
    "+один",
    "@@ -100,2 +200,2 @@",
    " сто",
    "+двести",
  ].join("\n");
  expect(parseDiffLines(diff).map((line) => [line.oldLine, line.newLine]))
    .toStrictEqual([
      [1, undefined],
      [undefined, 1],
      [100, 200],
      [undefined, 201],
    ]);
  expect(countDiff(diff)).toStrictEqual({ additions: 2, deletions: 1 });
});

it("пустой diff (binary) — ноль строк и нулевые счётчики", () => {
  expect(parseDiffLines("")).toStrictEqual([]);
  expect(countDiff("")).toStrictEqual({ additions: 0, deletions: 0 });
});

it("хвостовой перевод строки не создаёт строку за концом файла", () => {
  // Поле `diff` GitLab всегда кончается «\n»: если считать последний
  // кусок split контекстом, у файла из трёх строк появится адресуемая
  // четвёртая — и инлайн-комментарий на неё ляжет не туда.
  const lines = parseDiffLines("@@ -1,2 +1,3 @@\n контекст\n-старая\n+новая\n");
  expect(lines.length).toBe(3);
  expect(lines[2]).toStrictEqual({
    kind: "added",
    oldLine: undefined,
    newLine: 2,
    text: "новая",
  });
});
