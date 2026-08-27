/**
 * Копии golden-фикстур в `testdata/` обязаны совпадать с каналом
 * спецификаций байт-в-байт (`docs/CLAUDE.md`, «Правила для изолированной
 * Deno-сессии»). Без этой сверки расхождение молчит: тесты продолжают
 * проходить на устаревшей копии, а обновлённый эталон канала никто не
 * перечитывает.
 */

import { assertEquals } from "@std/assert";

/** Область канала и её копия: подкаталог `testdata/` назван так же. */
const CHANNEL = "claude-hook-notification";

const NAMES: readonly string[] = [
  "err-bad-json-stderr.txt",
  "notify-stdout.txt",
];

const channelRoot = new URL("../../docs/specs/fixtures/", import.meta.url);
const copyRoot = new URL("testdata/", import.meta.url);

Deno.test("копии фикстур совпадают с каналом спецификаций", async (t) => {
  for (const name of NAMES) {
    await t.step(`${CHANNEL}/${name}`, async () => {
      assertEquals(
        await Deno.readTextFile(new URL(`${CHANNEL}/${name}`, copyRoot)),
        await Deno.readTextFile(new URL(`${CHANNEL}/${name}`, channelRoot)),
      );
    });
  }
});

Deno.test("в testdata нет копий, которых нет в канале", async () => {
  const found: string[] = [];
  for await (const entry of Deno.readDir(new URL(`${CHANNEL}/`, copyRoot))) {
    found.push(entry.name);
  }
  assertEquals(found.sort(), [...NAMES].sort());
});
