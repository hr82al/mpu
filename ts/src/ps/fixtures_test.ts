/**
 * Копии golden-фикстур обязаны совпадать с каналом спецификаций
 * байт-в-байт (`docs/CLAUDE.md`).
 */

import { assertEquals } from "@std/assert";

const CHANNEL = "ps";

const NAMES: readonly string[] = [
  "cache-filter-stdout.txt",
  "cache-json-stdout.txt",
  "cache-table-stderr.txt",
  "cache-table-stdout.txt",
  "cache-tsv-stdout.txt",
  "empty-cache-stderr.txt",
  "err-no-table-stderr.txt",
  "live-containers-json.json",
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

Deno.test("в testdata нет копий, которых нет в канале", async () => {
  const found: string[] = [];
  for await (const entry of Deno.readDir(copyDir)) found.push(entry.name);
  assertEquals(found.sort(), [...NAMES].sort());
});
