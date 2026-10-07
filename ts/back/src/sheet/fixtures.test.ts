/**
 * Копии golden-фикстур обязаны совпадать с каналом спецификаций
 * байт-в-байт (`docs/CLAUDE.md`).
 */

import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/** Каналы двух семейств: чтение таблиц и пакетные операции. */
const CHANNELS: Readonly<Record<string, readonly string[]>> = {
  sheet: [
    "err-no-ranges.stderr",
    "get-both-cached.stdout",
    "get-raw.stdout",
    "get-tsv.stdout",
    "ls-json.stdout",
    "ls-long-json.stdout",
    "ls-long.stdout",
    "resolve.stdout",
  ],
  "sheet-batch": [
    "err-sheet-created-in-same-script.stderr",
    "get-values-and-meta.stdout",
    "update-all-verbs.script",
    "update-all-verbs.stdout",
  ],
};

const copyDir = (channel: string) =>
  new URL(`testdata/${channel}/`, import.meta.url);

describe("копии фикстур совпадают с каналом спецификаций", () => {
  for (const [channel, names] of Object.entries(CHANNELS)) {
    for (const name of names) {
      it(`${channel}/${name}`, async () => {
        expect(
          await readFile(new URL(name, copyDir(channel)), "utf8"),
        ).toStrictEqual(
          await readFile(
            new URL(
              `../../../docs/specs/fixtures/${channel}/${name}`,
              import.meta.url,
            ),
            "utf8",
          ),
        );
      });
    }
  }
});

it("в testdata нет копий, которых нет в канале", async () => {
  for (const [channel, names] of Object.entries(CHANNELS)) {
    const found = await readdir(copyDir(channel));
    expect(found.sort(), channel).toStrictEqual([...names].sort());
  }
});
