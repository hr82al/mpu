/**
 * Копия golden-фикстуры в `testdata/` обязана совпадать с каналом
 * спецификаций байт-в-байт (`docs/CLAUDE.md`, «Правила для изолированной
 * Deno-сессии»). Без этой сверки расхождение молчит: тесты продолжают
 * проходить на устаревшей копии, а обновлённый эталон канала никто не
 * перечитывает.
 *
 * Тест на файл, а не на каталог: имя разошедшегося эталона должно быть
 * видно из отчёта, без запуска diff'а вручную.
 */

import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/** Golden-файл: имя копии и каталог канала, откуда она снята. */
const FIXTURES: readonly (readonly [string, string])[] = [
  ["series-ok.json", "platform/loki-http"],
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
