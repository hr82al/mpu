/**
 * Копии golden-фикстур обязаны совпадать с каналом спецификаций
 * байт-в-байт (`docs/CLAUDE.md`). В копию взято только то, чем
 * пользуется реализованная поверхность: дерево-фикстура и три голдена
 * `refs`, `twins` и `name`. Голдены `mentions` лежат в канале и приедут
 * вместе со своей командой.
 */

import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const CHANNEL = "code";

/** Пути относительно каталога канала; каталоги — через «/». */
const NAMES: readonly string[] = [
  "broken-tree/src/a.ts.txt",
  "broken-tree/tsconfig.json.txt",
  "deno-tree/deno.json.txt",
  "deno-tree/mod.ts.txt",
  "deno-tree/src/broken.ts.txt",
  "deno-tree/src/days.ts.txt",
  "deno-tree/src/ext.ts.txt",
  "deno-tree/src/seed_test.ts.txt",
  "deno-tree/src/window.ts.txt",
  "name-collision.stdout.txt",
  "name-empty.stdout.txt",
  "refs-module.stdout.txt",
  "refs-orphan.stdout.txt",
  "mentions-stale.stdout.txt",
  "refs-refused.stdout.txt",
  "refs-symbol-deno.stdout.txt",
  "refs-symbol.stdout.txt",
  "tree/docs/guide.md.txt",
  "tree/src/aliased.ts.txt",
  "tree/src/broken.ts.txt",
  "tree/src/days.ts.txt",
  "tree/src/dynamic.ts.txt",
  "tree/src/grid.ts.txt",
  "tree/src/index.ts.txt",
  "tree/src/loaderA.ts.txt",
  "tree/src/loaderB.ts.txt",
  "tree/src/orphan.ts.txt",
  "tree/src/report.spec.ts.txt",
  "tree/src/seed_test.ts.txt",
  "tree/src/span.ts.txt",
  "tree/src/window.ts.txt",
  "tree/tsconfig.json.txt",
  "twins-exact.stdout.txt",
  "twins-similar.stdout.txt",
];

const copyDir = new URL(`testdata/${CHANNEL}/`, import.meta.url);

describe("копии фикстур совпадают с каналом спецификаций", () => {
  for (const name of NAMES) {
    it(name, async () => {
      expect(await readFile(new URL(name, copyDir), "utf8")).toStrictEqual(
        await readFile(
          new URL(
            `../../../docs/specs/fixtures/${CHANNEL}/${name}`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
    });
  }
});

it("в testdata нет копий, которых нет в списке", async () => {
  const found: string[] = [];
  for await (const path of walk(copyDir, "")) found.push(path);
  expect(found.sort()).toStrictEqual([...NAMES].sort());
});

/** Пути всех файлов поддерева относительно его корня. */
async function* walk(dir: URL, prefix: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      yield* walk(new URL(`${entry.name}/`, dir), `${name}/`);
      continue;
    }
    yield name;
  }
}
