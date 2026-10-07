/**
 * Копии golden-фикстур обязаны совпадать с каналом спецификаций
 * байт-в-байт (`docs/CLAUDE.md`). Сверяются копии всех девяти файлов
 * канала `search` — восемь снятых на синтетическом конфиге и рукописный
 * `staff-search-access.json`.
 */

import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";

const CHANNEL = "search";

const NAMES: readonly string[] = [
  "err-two-projections.stderr.txt",
  "local-empty.stdout.txt",
  "local-happy.stdout.txt",
  "local-ip.stdout.txt",
  "local-numeric-not-sid.stdout.txt",
  "local-projection-client-id.stdout.txt",
  "local-projection-sids.stdout.txt",
  "local-sid.stdout.txt",
  "staff-search-access.json",
];

const copyDir = new URL(`testdata/`, import.meta.url);

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
  for (
    const entry of await readdir(copyDir, { withFileTypes: true })
  ) found.push(entry.name);
  expect(found.sort()).toStrictEqual([...NAMES].sort());
});
