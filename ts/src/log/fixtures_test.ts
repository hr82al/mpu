/**
 * Копии golden-фикстур обязаны совпадать с каналом спецификаций
 * байт-в-байт (`docs/CLAUDE.md`). Сверяются копии всех восьми файлов
 * канала `log`, снятых на синтетическом журнале (`docs/specs/log.md`,
 * «Golden-примеры»).
 */

import { assertEquals } from "@std/assert";

const CHANNEL = "log";

const NAMES: readonly string[] = [
  "by-run.stdout.txt",
  "cmd-prefix.stdout.txt",
  "empty-result.stderr.txt",
  "err-since.stderr.txt",
  "failed.stdout.txt",
  "journal.log",
  "tail-1.stdout.txt",
  "tail-default.stdout.txt",
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
