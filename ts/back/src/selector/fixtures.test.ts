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

import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/** Golden-файлы формата ошибок селектора, скопированные в testdata модуля. */
const FIXTURES: readonly string[] = [
  "err-bad-server.txt",
  "err-email-not-cached.txt",
  "err-nothing-matched.txt",
];

const channelDir = new URL(
  "../../../docs/specs/fixtures/platform/selector/",
  import.meta.url,
);
const copyDir = new URL("testdata/", import.meta.url);

describe("копии фикстур совпадают с каналом спецификаций", () => {
  for (const name of FIXTURES) {
    it(name, async () => {
      expect(await readFile(new URL(name, copyDir), "utf8")).toStrictEqual(
        await readFile(new URL(name, channelDir), "utf8"),
      );
    });
  }
});

it("в testdata нет копий, которых нет в канале", async () => {
  const copied: string[] = [];
  for (const entry of await readdir(copyDir, { withFileTypes: true })) {
    copied.push(entry.name);
  }
  expect(copied.sort()).toStrictEqual([...FIXTURES].sort());
});
