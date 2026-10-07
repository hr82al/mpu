/**
 * Копии golden-фикстур обязаны совпадать с каналом спецификаций
 * байт-в-байт (`docs/CLAUDE.md`).
 */

import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";

const NAMES: readonly string[] = [
  "dry-run.stdout",
  "dry-run-no-image.stdout",
  "overrides/sl-base.observability-off.yaml",
  "overrides/sl-instance.observability-off.yaml",
  "overrides/sl-main.observability-off.yaml",
];
const copyDir = new URL("testdata/mp-init/", import.meta.url);

describe("копии фикстур совпадают с каналом спецификаций", () => {
  for (const name of NAMES) {
    it(name, async () => {
      expect(await readFile(new URL(name, copyDir), "utf8")).toStrictEqual(
        await readFile(
          new URL(
            `../../../docs/specs/fixtures/mp-init/${name}`,
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
  ) {
    if (!entry.isDirectory()) {
      found.push(entry.name);
      continue;
    }
    for (
      const inner of await readdir(new URL(`${entry.name}/`, copyDir), {
        withFileTypes: true,
      })
    ) {
      found.push(`${entry.name}/${inner.name}`);
    }
  }
  expect(found.sort()).toStrictEqual([...NAMES].sort());
});
