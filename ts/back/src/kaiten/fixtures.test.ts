/**
 * Копии golden-фикстур в `testdata/` обязаны совпадать с каналом
 * спецификаций байт-в-байт (`docs/CLAUDE.md`, «Правила для изолированной
 * Deno-сессии»). Без этой сверки расхождение молчит: тесты продолжают
 * проходить на устаревшей копии, а обновлённый эталон канала никто не
 * перечитывает.
 *
 * Тест на файл, а не на каталог: имя разошедшегося эталона должно быть
 * видно из отчёта, без запуска diff'а вручную. Калька с
 * `src/loki/fixtures.test.ts` — сверка копий форм ответов внешней системы
 * живёт рядом с кодом `ts/` того же домена; разбирает их библиотека.
 */

import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/** Golden-файл: имя копии и каталог канала, откуда она снята. */
const FIXTURES: readonly (readonly [string, string])[] = [
  ["spaces-ok.json", "platform/kaiten-http"],
  ["lanes-ok.json", "platform/kaiten-http"],
  ["columns-ok.json", "platform/kaiten-http"],
  ["roles-ok.json", "platform/kaiten-http"],
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
  const copied = await readdir(copyDir);
  expect(copied.sort()).toStrictEqual(FIXTURES.map(([name]) => name).sort());
});
