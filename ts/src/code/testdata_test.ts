/**
 * Копии golden-фикстур обязаны совпадать с каналом спецификаций
 * байт-в-байт (`docs/CLAUDE.md`). В копию взято только то, чем
 * пользуется реализованная поверхность: дерево-фикстура и три голдена
 * `refs`. Голдены `twins`/`name`/`mentions` лежат в канале и приедут
 * вместе со своими командами.
 */

import { assertEquals } from "@std/assert";

const CHANNEL = "code";

/** Пути относительно каталога канала; каталоги — через «/». */
const NAMES: readonly string[] = [
  "refs-module.stdout.txt",
  "refs-orphan.stdout.txt",
  "refs-symbol.stdout.txt",
  "tree/docs/guide.md.txt",
  "tree/src/aliased.ts.txt",
  "tree/src/broken.ts.txt",
  "tree/src/days.ts.txt",
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
];

const copyDir = new URL(`testdata/${CHANNEL}/`, import.meta.url);

Deno.test("копии фикстур совпадают с каналом спецификаций", async (t) => {
  for (const name of NAMES) {
    await t.step(name, async () => {
      assertEquals(
        await Deno.readTextFile(new URL(name, copyDir)),
        await Deno.readTextFile(
          new URL(
            `../../docs/specs/fixtures/${CHANNEL}/${name}`,
            import.meta.url,
          ),
        ),
      );
    });
  }
});

Deno.test("в testdata нет копий, которых нет в списке", async () => {
  const found: string[] = [];
  for await (const path of walk(copyDir, "")) found.push(path);
  assertEquals(found.sort(), [...NAMES].sort());
});

/** Пути всех файлов поддерева относительно его корня. */
async function* walk(dir: URL, prefix: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory) {
      yield* walk(new URL(`${entry.name}/`, dir), `${name}/`);
      continue;
    }
    yield name;
  }
}
