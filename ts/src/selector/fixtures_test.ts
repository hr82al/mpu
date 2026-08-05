/**
 * Копии golden-фикстур в `testdata/` обязаны совпадать с каналом
 * спецификаций байт-в-байт (`docs/CLAUDE.md`, «Правила для изолированной
 * Deno-сессии»). Без этой сверки расхождение молчит: тесты продолжают
 * проходить на устаревшей копии, а обновлённый эталон канала никто не
 * перечитывает.
 *
 * Тест на файл, а не на каталог: имя разошедшегося эталона должно быть
 * видно из отчёта, без запуска diff'а вручную.
 *
 * Фикстуры `dry-v-*.txt` канала относятся к мета-блоку SQL-команды и в
 * этот модуль не копируются.
 */

import { assertEquals } from "@std/assert";

/** Golden-файлы формата ошибок селектора, скопированные в testdata модуля. */
const FIXTURES: readonly string[] = [
  "err-bad-server.txt",
  "err-email-not-cached.txt",
  "err-nothing-matched.txt",
];

const channelDir = new URL(
  "../../docs/specs/fixtures/platform/selector/",
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
  for await (const entry of Deno.readDir(copyDir)) {
    copied.push(entry.name);
  }
  assertEquals(copied.sort(), [...FIXTURES].sort());
});
