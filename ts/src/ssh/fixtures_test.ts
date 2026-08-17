/**
 * Копии golden-фикстур обязаны совпадать с каналом спецификаций
 * байт-в-байт (`docs/CLAUDE.md`, «Правила для изолированной
 * Deno-сессии»): иначе тесты проходят на устаревшей копии.
 */

import { assertEquals } from "@std/assert";

const CHANNEL = "ssh";

const NAMES: readonly string[] = [
  "err-all-containers-empty-stderr.txt",
  "err-dev-selector-stderr.txt",
  "err-empty-cmd-stderr.txt",
  "err-stdin-mutex-stderr.txt",
  "ok-echo-stdout.txt",
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
