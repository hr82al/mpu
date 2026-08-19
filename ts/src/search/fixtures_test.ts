/**
 * Копии golden-фикстур обязаны совпадать с каналом спецификаций
 * байт-в-байт (`docs/CLAUDE.md`). Сверяются копии всех девяти файлов
 * канала `search` — восемь снятых на синтетическом конфиге и рукописный
 * `staff-search-access.json`.
 */

import { assertEquals } from "@std/assert";

const CHANNEL = "search";

const NAMES: readonly string[] = [
  "err-two-projections.stderr.txt",
  "local-empty.stdout.txt",
  "local-happy.stdout.txt",
  "local-ip.stdout.txt",
  "local-numeric-not-sid.stdout.txt",
  "local-projection-client-id.stdout.txt",
  "local-projection-sids.stdout.txt",
  "local-sid.stdout.txt",
  "staff-search-access.json",
];

const copyDir = new URL(`testdata/`, import.meta.url);

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
