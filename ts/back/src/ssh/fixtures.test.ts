/**
 * Копии golden-фикстур обязаны совпадать с каналом спецификаций
 * байт-в-байт (`docs/CLAUDE.md`, «Правила для изолированной
 * Deno-сессии»): иначе тесты проходят на устаревшей копии.
 */

import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const CHANNEL = "ssh";

const NAMES: readonly string[] = [
  "err-all-containers-empty-stderr.txt",
  "err-dev-selector-stderr.txt",
  "err-empty-cmd-stderr.txt",
  "err-stdin-mutex-stderr.txt",
  "ok-echo-stdout.txt",
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
