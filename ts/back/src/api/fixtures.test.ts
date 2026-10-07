/**
 * Копии golden-фикстур обязаны совпадать с каналом спецификаций
 * байт-в-байт (`docs/CLAUDE.md`).
 */

import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const NAMES: readonly string[] = [
  "get-client.json",
  "list-client-modules.json",
];
const copyDir = new URL("testdata/api/", import.meta.url);

describe("копии фикстур совпадают с каналом спецификаций", () => {
  for (const name of NAMES) {
    it(name, async () => {
      expect(await readFile(new URL(name, copyDir), "utf8")).toStrictEqual(
        await readFile(
          new URL(`../../../docs/specs/fixtures/api/${name}`, import.meta.url),
          "utf8",
        ),
      );
    });
  }
});

it("в testdata нет копий, которых нет в канале", async () => {
  const found = await readdir(copyDir);
  expect(found.sort()).toStrictEqual([...NAMES].sort());
});
