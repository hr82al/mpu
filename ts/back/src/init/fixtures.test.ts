/**
 * Копии golden-фикстур в `testdata/` обязаны совпадать с каналом
 * спецификаций байт-в-байт (`docs/CLAUDE.md`, «Правила для изолированной
 * Deno-сессии»). Без этой сверки расхождение молчит: тесты продолжают
 * проходить на устаревшей копии, а обновлённый эталон канала никто не
 * перечитывает.
 *
 * Тест на файл, а не на каталог: имя разошедшегося эталона должно быть
 * видно из отчёта, без запуска diff'а вручную. Калька с
 * `src/env/fixtures_test.ts` и `src/store/fixtures_test.ts`.
 *
 * Здесь — только свои golden команды. Формы ответов атомов, которые
 * она зовёт, сверяются там же, где живут атомы: `src/loki/` и
 * `src/kaiten/`.
 */

import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";

/** Golden-файл: имя копии и каталог канала, откуда она снята. */
const FIXTURES: readonly (readonly [string, string])[] = [
  ["err-no-api-key.txt", "init"],
  ["err-no-url.txt", "init"],
];

const channelRoot = new URL("../../../docs/specs/fixtures/", import.meta.url);
const copyDir = new URL("testdata/", import.meta.url);

describe("копии фикстур совпадают с каналом спецификаций", () => {
  for (const [name, dir] of FIXTURES) {
    it(`${dir}/${name}`, async () => {
      expect(await readFile(new URL(name, copyDir), "utf8")).toStrictEqual(
        await readFile(new URL(`${dir}/${name}`, channelRoot), "utf8"),
      );
    });
  }
});

it("в testdata нет копий, которых нет в канале", async () => {
  const copied: string[] = [];
  for (const entry of await readdir(copyDir, { withFileTypes: true })) {
    copied.push(entry.name);
  }
  expect(copied.sort()).toStrictEqual(FIXTURES.map(([name]) => name).sort());
});
