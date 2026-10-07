/**
 * Копии golden-фикстур обязаны совпадать с каналом спецификаций
 * байт-в-байт (`docs/CLAUDE.md`): иначе тесты проходят на устаревшей
 * копии, а обновлённый эталон канала никто не перечитывает.
 */

import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const CHANNEL = "confirm";

const NAMES: readonly string[] = [
  "confirm-stdout.txt",
  "err-cancelled-stderr.txt",
  "err-no-tty-stderr.txt",
];

const copyDir = new URL(`testdata/${CHANNEL}/`, import.meta.url);

describe("копии фикстур совпадают с каналом спецификаций", () => {
  for (const name of NAMES) {
    it(name, async () => {
      expect(await readFile(new URL(name, copyDir), "utf8")).toStrictEqual(
        await readFile(
          new URL(
            `../../../docs/specs/fixtures/${CHANNEL}/${name}`,
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
