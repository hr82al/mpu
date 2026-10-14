/**
 * Разбор патча `git diff -U0`: формы вывода git, которых сценарии
 * команд на временном репозитории не порождают.
 */

import { describe, expect, it } from "vitest";
import { readPatch, type TextSpan } from "./patch.ts";

/** Отрезок на одной строке: столбцы `[from, to)`. */
function on(line: number, from: number, to: number): TextSpan {
  return {
    start: { line, column: from },
    end: { line, column: to },
  };
}

/** Заголовки патча одного файла с путём новой стороны `path`. */
function header(path: string): string {
  return `diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ ${path}`;
}

/** Патч файла `a.ts` из кусков `hunks`. */
function patchOf(hunks: string) {
  return readPatch(`${header("b/a.ts")}\n${hunks}`)[0];
}

describe("путь новой стороны", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["b/src/a.ts", "src/a.ts"],
    ["b/src/a b.ts\t", "src/a b.ts"],
    ['"b/src/a\\"b\\tc.ts"', 'src/a"b\tc.ts'],
    ['"b/\\321\\217.ts"', "я.ts"],
  ];
  for (const [raw, path] of cases) {
    it(raw, () => {
      const patch = readPatch(`${header(raw)}\n@@ -1 +1 @@\n-a\n+b\n`);
      expect(patch.map((file) => file.path)).toStrictEqual([path]);
    });
  }
});

describe("содержимое куска забирается по счёту заголовка", () => {
  it("строка содержимого вида +++ — не заголовок файла", () => {
    const patch = readPatch(
      `${header("b/a.ts")}\n@@ -2 +2 @@\n----\n+++ b/x\n@@ -9,0 +10 @@\n+y\n`,
    );
    expect(patch.map((file) => file.path)).toStrictEqual(["a.ts"]);
    expect(patch[0].lines()).toStrictEqual([2, 10]);
  });

  it("примечание о конце файла в счёт не входит", () => {
    const patch = patchOf(
      "@@ -3 +3 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n@@ -7 +7 @@\n-c\n+d\n",
    );
    expect(patch.lines()).toStrictEqual([3, 7]);
  });
});

describe("что задевает кусок", () => {
  const rewrite = patchOf(
    "@@ -1 +1 @@\n-function foo() {\n+function barbaz() {\n",
  );
  const removal = patchOf("@@ -5 +4,0 @@\n-x\n");
  // Две строки вместо одной: новые строки 3 и 4 изменены целиком.
  const lines = patchOf("@@ -3 +3,2 @@\n-x\n+y\n+z\n");

  const cases: readonly {
    readonly name: string;
    readonly touched: boolean;
    readonly actual: () => boolean;
  }[] = [
    {
      name: "замена левее { отрезка не задевает",
      touched: false,
      actual: () => rewrite.touches(on(1, 18, 19)),
    },
    {
      name: "замена задевает отрезок, начатый левее",
      touched: true,
      actual: () => rewrite.touches(on(1, 0, 19)),
    },
    {
      name: "удаление между строками отрезка задевает",
      touched: true,
      actual: () =>
        removal.touches({
          start: { line: 3, column: 2 },
          end: { line: 6, column: 1 },
        }),
    },
    {
      name: "удаление за последней строкой отрезка не задевает",
      touched: false,
      actual: () =>
        removal.touches({
          start: { line: 2, column: 0 },
          end: { line: 4, column: 1 },
        }),
    },
    {
      name: "неравная замена задевает отрезок на своей строке",
      touched: true,
      actual: () => lines.touches(on(4, 7, 8)),
    },
    {
      name: "неравная замена не задевает отрезок со следующей строки",
      touched: false,
      actual: () =>
        lines.touches({
          start: { line: 5, column: 0 },
          end: { line: 9, column: 1 },
        }),
    },
  ];
  for (const { name, touched, actual } of cases) {
    it(name, () => {
      expect(actual()).toBe(touched);
    });
  }
});
