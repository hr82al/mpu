/**
 * Копии golden-фикстур обязаны совпадать с каналом спецификаций
 * байт-в-байт (`docs/CLAUDE.md`).
 */

import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const NAMES: readonly string[] = [
  "sample.d2",
  "sample.svg",
  "sample-dry-run.txt",
  "sample-cyrillic.d2",
  "sample-cyrillic.svg",
  "sample-cyrillic-dry-run.txt",
  // Снятое с живой службы: формы ответов Miro, из которых выросла
  // граница клиента (`d2-miro.md`, «Снято с живой службы»).
  "child-absolute-position-400.json",
  "connector-created.json",
  "frame-children.json",
  "frame-created.json",
  "orphan-after-frame-delete.json",
  "patch-unlock.json",
  "shape-created.json",
  "text-created.json",
];
const copyDir = new URL("testdata/d2-miro/", import.meta.url);

/** Живые снимки лежат в канале подкаталогом; копии — рядом с прочими. */
function live(name: string): string {
  return name.endsWith(".json") ? "live/" : "";
}

describe("копии фикстур совпадают с каналом спецификаций", () => {
  for (const name of NAMES) {
    it(name, async () => {
      expect(await readFile(new URL(name, copyDir), "utf8")).toStrictEqual(
        await readFile(
          new URL(
            `../../../docs/specs/fixtures/d2-miro/${live(name)}${name}`,
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
