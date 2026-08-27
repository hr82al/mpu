/**
 * Копии golden-фикстур обязаны совпадать с каналом спецификаций
 * байт-в-байт (`docs/CLAUDE.md`).
 */

import { assertEquals } from "@std/assert";

/** Каналы фикстур семейства и их состав. */
const CHANNELS: Readonly<Record<string, readonly string[]>> = {
  "mr-read": [
    "comments.json",
    "err-diff-no-match.stderr",
    "err-mr-not-found.stderr",
    "files.json",
    "view.json",
  ],
  "mr-write": [
    "comment-created.stdout",
    "create.stdout",
    "delete-no-tty.stderr",
    "describe.stdout",
    "edit.stdout",
    "err-line-outside-diff.stderr",
    "note-created.stdout",
    "reply-created.stdout",
    "resolve.stdout",
    "show-thread.json",
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

Deno.test("в testdata нет копий, которых нет в канале", async (t) => {
  for (const [channel, names] of Object.entries(CHANNELS)) {
    await t.step(channel, async () => {
      const found: string[] = [];
      for await (const entry of Deno.readDir(copyDir(channel))) {
        found.push(entry.name);
      }
      assertEquals(found.sort(), [...names].sort());
    });
  }
});
