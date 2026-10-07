/**
 * Копии эталонов объектов в `testdata/` обязаны совпадать с каналом
 * спецификаций байт-в-байт.
 */

import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const FIXTURES: readonly string[] = [
  "cases.json",
  "help-card-keyword.txt",
  "help-card-keyword-end.txt",
  "help-card-word-abc.txt",
  "help-card-word.txt",
  "help-comment.txt",
  "help-kiten-card.txt",
  "help-kiten-ls.txt",
  "help-kiten.txt",
  "help-root.txt",
  "help-version.txt",
];

const channelDir = new URL(
  "../../../docs/specs/fixtures/objects/",
  import.meta.url,
);
const copyDir = new URL("testdata/objects/", import.meta.url);

describe("копии эталонов объектов совпадают с каналом", () => {
  for (const name of FIXTURES) {
    it(name, async () => {
      expect(await readFile(new URL(name, copyDir), "utf8")).toStrictEqual(
        await readFile(new URL(name, channelDir), "utf8"),
      );
    });
  }
});

it("в testdata объектов нет копий, которых нет в канале", async () => {
  const copied: string[] = [];
  for (const entry of await readdir(copyDir, { withFileTypes: true })) {
    copied.push(entry.name);
  }
  expect(copied.sort()).toStrictEqual([...FIXTURES].sort());
});
