/**
 * Копии golden-фикстур обязаны совпадать с каналом спецификаций
 * байт-в-байт (`docs/CLAUDE.md`). Сверяются копии всех восьми файлов
 * канала `log`, снятых на синтетическом журнале (`docs/specs/log.md`,
 * «Golden-примеры»).
 */

import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const CHANNEL = "log";

const NAMES: readonly string[] = [
  "by-run.stdout.txt",
  "cmd-prefix.stdout.txt",
  "empty-result.stderr.txt",
  "err-since.stderr.txt",
  "failed.stdout.txt",
  "journal.log",
  "tail-1.stdout.txt",
  "tail-default.stdout.txt",
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
  for (const entry of await readdir(copyDir, { withFileTypes: true })) {
    found.push(entry.name);
  }
  expect(found.sort()).toStrictEqual([...NAMES].sort());
});
