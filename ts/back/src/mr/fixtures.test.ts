/**
 * Копии golden-фикстур обязаны совпадать с каналом спецификаций
 * байт-в-байт (`docs/CLAUDE.md`).
 */

import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

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

describe("в testdata нет копий, которых нет в канале", () => {
  for (const [channel, names] of Object.entries(CHANNELS)) {
    it(channel, async () => {
      const found: string[] = [];
      for (const entry of await readdir(copyDir(channel), {
        withFileTypes: true,
      })) {
        found.push(entry.name);
      }
      expect(found.sort()).toStrictEqual([...names].sort());
    });
  }
});
