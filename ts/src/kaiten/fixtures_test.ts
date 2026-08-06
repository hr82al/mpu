/**
 * Копии golden-фикстур в `testdata/` обязаны совпадать с каналом
 * спецификаций байт-в-байт (`docs/CLAUDE.md`, «Правила для изолированной
 * Deno-сессии»). Без этой сверки расхождение молчит: тесты продолжают
 * проходить на устаревшей копии, а обновлённый эталон канала никто не
 * перечитывает.
 *
 * Тест на файл, а не на каталог: имя разошедшегося эталона должно быть
 * видно из отчёта, без запуска diff'а вручную. Калька с
 * `src/loki/fixtures_test.ts` — сверка форм ответов внешней системы
 * живёт там же, где атом, который их разбирает.
 */

import { assertEquals } from "@std/assert";

/** Golden-файл: имя копии и каталог канала, откуда она снята. */
const FIXTURES: readonly (readonly [string, string])[] = [
  ["spaces-ok.json", "platform/kaiten-http"],
  ["lanes-ok.json", "platform/kaiten-http"],
  ["columns-ok.json", "platform/kaiten-http"],
  ["roles-ok.json", "platform/kaiten-http"],
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
