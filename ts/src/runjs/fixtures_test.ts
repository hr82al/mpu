/**
 * Копии golden-фикстур обязаны совпадать с каналом спецификаций
 * байт-в-байт (`docs/CLAUDE.md`): иначе тесты проходят на устаревшей
 * копии, а переснятый эталон никто не перечитывает.
 */

import { assertEquals } from "@std/assert";

const CHANNEL = "run-js";

const NAMES: readonly string[] = [
  "dry-run-stdout.txt",
  "err-code-and-file-stderr.txt",
  "err-empty-js-stderr.txt",
  "ok-console-log-stderr.txt",
  "ok-console-log-stdout.txt",
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
