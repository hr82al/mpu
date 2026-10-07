/**
 * Копии golden-фикстур в `testdata/` обязаны совпадать с каналом
 * спецификаций байт-в-байт (`docs/CLAUDE.md`, «Правила для изолированной
 * Deno-сессии»). Без этой сверки расхождение молчит: тесты продолжают
 * проходить на устаревшей копии, а обновлённый эталон канала никто не
 * перечитывает.
 */

import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";

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

const channelDir = new URL(
  "../../../docs/specs/fixtures/logs/",
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
  for (
    const entry of await readdir(copyDir, { withFileTypes: true })
  ) copied.push(entry.name);
  expect(copied.sort()).toStrictEqual([...FIXTURES].sort());
});
