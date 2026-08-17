/**
 * Копии golden-фикстур в `testdata/` обязаны совпадать с каналом
 * спецификаций байт-в-байт (`docs/CLAUDE.md`, «Правила для изолированной
 * Deno-сессии»). Без этой сверки расхождение молчит: тесты продолжают
 * проходить на устаревшей копии, а обновлённый эталон канала никто не
 * перечитывает.
 *
 * Каталогов канала три: своя спека команды и два соседних атома, чьи
 * эталоны сверяет она же (`specs/sql-ro.md`, «Golden-примеры»).
 */

import { assertEquals } from "@std/assert";

/** Каталог канала → скопированные из него файлы. */
const FIXTURES: Readonly<Record<string, readonly string[]>> = {
  "sql-ro": [
    "db-error-stderr.txt",
    "dry-v-dev-stderr.txt",
    "dry-v-server-stderr.txt",
    "noresultset-stdout.txt",
    "semi-first-stdout.txt",
    "table-empty-md.txt",
    "table-empty-stdout.txt",
    "table-md-escapes.txt",
    "table-multiline-stdout.txt",
    "table-nulls-json.txt",
    "table-nulls-md.txt",
    "table-nulls-stdout.txt",
  ],
  "platform/readonly-default": [
    "dry-v-stderr.txt",
    "select1-stdout.json",
    "write-refused-stderr.txt",
  ],
  "platform/selector": [
    "dry-v-client-stderr.txt",
    "dry-v-sl0-stderr.txt",
  ],
};

const copyDir = new URL("testdata/", import.meta.url);

Deno.test("копии фикстур совпадают с каналом спецификаций", async (t) => {
  for (const [dir, names] of Object.entries(FIXTURES)) {
    const channelDir = new URL(
      `../../docs/specs/fixtures/${dir}/`,
      import.meta.url,
    );
    for (const name of names) {
      await t.step(`${dir}/${name}`, async () => {
        assertEquals(
          await Deno.readTextFile(new URL(name, copyDir)),
          await Deno.readTextFile(new URL(name, channelDir)),
        );
      });
    }
  }
});

Deno.test("в testdata нет копий, которых нет в канале", async () => {
  const copied: string[] = [];
  for await (const entry of Deno.readDir(copyDir)) copied.push(entry.name);
  assertEquals(copied.sort(), Object.values(FIXTURES).flat().sort());
});
