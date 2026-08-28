/**
 * Копии golden-фикстур обязаны совпадать с каналом спецификаций
 * байт-в-байт (`docs/CLAUDE.md`).
 */

import { assertEquals } from "@std/assert";

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

Deno.test("копии фикстур совпадают с каналом спецификаций", async (t) => {
  for (const [channel, names] of Object.entries(CHANNELS)) {
    for (const name of names) {
      await t.step(`${channel}/${name}`, async () => {
        assertEquals(
          await Deno.readTextFile(new URL(name, copyDir(channel))),
          await Deno.readTextFile(
            new URL(
              `../../docs/specs/fixtures/${channel}/${name}`,
              import.meta.url,
            ),
          ),
        );
      });
    }
  }
});

Deno.test("в testdata нет копий, которых нет в канале", async () => {
  for (const [channel, names] of Object.entries(CHANNELS)) {
    const found: string[] = [];
    for await (const entry of Deno.readDir(copyDir(channel))) {
      found.push(entry.name);
    }
    assertEquals(found.sort(), [...names].sort(), channel);
  }
});
