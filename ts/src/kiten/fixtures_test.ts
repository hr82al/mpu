/**
 * Копии golden-фикстур в `testdata/` обязаны совпадать с каналом
 * спецификаций байт-в-байт (`docs/CLAUDE.md`, «Правила для изолированной
 * Deno-сессии»). Без этой сверки расхождение молчит: тесты продолжают
 * проходить на устаревшей копии, а обновлённый эталон канала никто не
 * перечитывает.
 */

import { assertEquals } from "@std/assert";

/** Эталоны канала `fixtures/kiten-card/`, скопированные в `testdata/`. */
const FIXTURES: readonly string[] = [
  "live-raw-card.json",
  "live-raw-comments.json",
  "raw-card-file-property.json",
  "live-json-stdout.json",
  "live-md-stdout.md",
  "live-md-no-comments-stdout.md",
  "live-empty-json-stdout.json",
  "live-empty-md-stdout.md",
  "synthetic-card-detail.json",
  "synthetic-comments.json",
  "synthetic-json-stdout.json",
  "synthetic-md-stdout.md",
  "synthetic-md-no-comments-stdout.md",
  "err-not-found-stderr.txt",
  "err-selector-message.txt",
];

const channelDir = new URL(
  "../../docs/specs/fixtures/kiten-card/",
  import.meta.url,
);
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
