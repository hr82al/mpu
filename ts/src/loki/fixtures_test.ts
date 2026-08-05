/**
 * Копия golden-фикстуры в `testdata/` обязана совпадать с каналом
 * спецификаций байт-в-байт (`docs/CLAUDE.md`, «Правила для изолированной
 * Deno-сессии»). Без этой сверки расхождение молчит: тесты продолжают
 * проходить на устаревшей копии, а обновлённый эталон канала никто не
 * перечитывает.
 *
 * Тест на файл, а не на каталог: имя разошедшегося эталона должно быть
 * видно из отчёта, без запуска diff'а вручную. Калька с
 * `src/env/fixtures_test.ts` и `src/store/fixtures_test.ts`.
 */

import { assertEquals } from "@std/assert";

/** Golden-файл: имя копии и каталог канала, откуда она снята. */
const FIXTURES: readonly (readonly [string, string])[] = [
  ["series-ok.json", "platform/loki-http"],
];

const channelRoot = new URL("../../docs/specs/fixtures/", import.meta.url);
const copyDir = new URL("testdata/", import.meta.url);

Deno.test("копии фикстур совпадают с каналом спецификаций", async (t) => {
  for (const [name, dir] of FIXTURES) {
    await t.step(`${dir}/${name}`, async () => {
      assertEquals(
        await Deno.readTextFile(new URL(name, copyDir)),
        await Deno.readTextFile(new URL(`${dir}/${name}`, channelRoot)),
      );
    });
  }
});

Deno.test("в testdata нет копий, которых нет в канале", async () => {
  const copied: string[] = [];
  for await (const entry of Deno.readDir(copyDir)) {
    copied.push(entry.name);
  }
  assertEquals(copied.sort(), FIXTURES.map(([name]) => name).sort());
});
