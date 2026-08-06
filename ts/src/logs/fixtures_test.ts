/**
 * Копии golden-фикстур в `testdata/` обязаны совпадать с каналом
 * спецификаций байт-в-байт (`docs/CLAUDE.md`, «Правила для изолированной
 * Deno-сессии»). Без этой сверки расхождение молчит: тесты продолжают
 * проходить на устаревшей копии, а обновлённый эталон канала никто не
 * перечитывает.
 */

import { assertEquals } from "@std/assert";

/** Эталоны канала `fixtures/logs/`, скопированные в `testdata/`. */
const FIXTURES: readonly string[] = [
  "err-follow-portainer.txt",
  "err-portainer-no-container.txt",
  "err-portainer-no-selector.txt",
  "err-services-empty.txt",
  "err-since-bad.txt",
  "err-via-unknown.txt",
  "ls-hosts-stdout.txt",
  "ls-services-stdout.txt",
];

const channelDir = new URL("../../docs/specs/fixtures/logs/", import.meta.url);
const copyDir = new URL("testdata/", import.meta.url);

Deno.test("копии фикстур совпадают с каналом спецификаций", async (t) => {
  for (const name of FIXTURES) {
    await t.step(name, async () => {
      assertEquals(
        await Deno.readTextFile(new URL(name, copyDir)),
        await Deno.readTextFile(new URL(name, channelDir)),
      );
    });
  }
});

Deno.test("в testdata нет копий, которых нет в канале", async () => {
  const copied: string[] = [];
  for await (const entry of Deno.readDir(copyDir)) copied.push(entry.name);
  assertEquals(copied.sort(), [...FIXTURES].sort());
});
