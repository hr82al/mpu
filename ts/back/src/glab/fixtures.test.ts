/**
 * Копии golden-фикстур обязаны совпадать с каналом спецификаций
 * байт-в-байт (`docs/CLAUDE.md`).
 */

import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// Текстовый голден снят из канала 2026-08-28: он был снят с рамочной
// таблицы прежней реализации, а рамки в контракт не входят — эталон,
// который нечем воспроизвести, хуже отсутствующего.
const NAMES: readonly string[] = ["single-mr.json"];
const copyDir = new URL("testdata/glab-status/", import.meta.url);

describe("копии фикстур совпадают с каналом спецификаций", () => {
  for (const name of NAMES) {
    it(name, async () => {
      expect(await readFile(new URL(name, copyDir), "utf8")).toStrictEqual(
        await readFile(
          new URL(
            `../../../docs/specs/fixtures/glab-status/${name}`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
    });
  }
});

it("в testdata нет копий, которых нет в канале", async () => {
  const found: string[] = [];
  for (const entry of await readdir(copyDir, { withFileTypes: true })) {
    found.push(entry.name);
  }
  expect(found.sort()).toStrictEqual([...NAMES].sort());
});
