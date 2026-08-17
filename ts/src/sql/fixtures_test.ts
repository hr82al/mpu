/**
 * Копии golden-фикстур в `testdata/` обязаны совпадать с каналом
 * спецификаций байт-в-байт (`docs/CLAUDE.md`, «Правила для изолированной
 * Deno-сессии»). Без этой сверки расхождение молчит: тесты продолжают
 * проходить на устаревшей копии, а обновлённый эталон канала никто не
 * перечитывает.
 *
 * Областей канала четыре: спеки обеих команд и два соседних атома, чьи
 * эталоны сверяет `sql-ro` (`specs/sql-ro.md`, «Golden-примеры»).
 * Эталоны `mpu sql` лежат в своём подкаталоге: имена файлов у команд
 * совпадают, а содержимое разное.
 */

import { assertEquals } from "@std/assert";

/** Область канала → её копия в `testdata/` и состав файлов. */
interface FixtureSet {
  readonly channel: string;
  /** Подкаталог `testdata/`; пустая строка — сам `testdata/`. */
  readonly copy: string;
  readonly names: readonly string[];
}

const FIXTURES: readonly FixtureSet[] = [{
  channel: "sql-ro",
  copy: "",
  names: [
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
}, {
  channel: "platform/readonly-default",
  copy: "",
  names: [
    "dry-v-stderr.txt",
    "select1-stdout.json",
    "write-refused-stderr.txt",
  ],
}, {
  channel: "platform/selector",
  copy: "",
  names: [
    "dry-v-client-stderr.txt",
    "dry-v-sl0-stderr.txt",
  ],
}, {
  channel: "sql",
  copy: "sql/",
  names: [
    "db-error-stderr.txt",
    "dry-v-server-stderr.txt",
    "ok-rowcount-json-stdout.txt",
    "ok-rowcount-stdout.txt",
  ],
}];

const copyDir = new URL("testdata/", import.meta.url);

Deno.test("копии фикстур совпадают с каналом спецификаций", async (t) => {
  for (const set of FIXTURES) {
    for (const name of set.names) {
      await t.step(`${set.channel}/${name}`, async () => {
        assertEquals(
          await Deno.readTextFile(new URL(`${set.copy}${name}`, copyDir)),
          await Deno.readTextFile(
            new URL(
              `../../docs/specs/fixtures/${set.channel}/${name}`,
              import.meta.url,
            ),
          ),
        );
      });
    }
  }
});

Deno.test("в testdata нет копий, которых нет в канале", async () => {
  const declared = FIXTURES
    .flatMap((set) => set.names.map((name) => `${set.copy}${name}`))
    .sort();
  assertEquals((await copiedNames()).sort(), declared);
});

/** Всё, что лежит в `testdata/`, путями относительно него. */
async function copiedNames(prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(new URL(prefix, copyDir))) {
    if (entry.isDirectory) {
      found.push(...await copiedNames(`${prefix}${entry.name}/`));
      continue;
    }
    found.push(`${prefix}${entry.name}`);
  }
  return found;
}
