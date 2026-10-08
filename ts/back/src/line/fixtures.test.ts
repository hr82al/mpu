/**
 * Копии эталона хука `PreToolUse` в `testdata/` обязаны совпадать с
 * каналом спецификаций байт-в-байт: иначе тесты молча проходят на
 * устаревшей копии.
 */

import { readdir, readFile } from "node:fs/promises";
import { expect, it } from "vitest";

/** Эталон хука `PreToolUse`: копии `testdata/` — те же файлы канала. */
const HOOK = "claude-hook-pre-tool-use";

it("копии эталона хука PreToolUse совпадают с каналом", async () => {
  const channelDir = new URL(
    `../../../docs/specs/fixtures/${HOOK}/`,
    import.meta.url,
  );
  const copyDir = new URL(`testdata/${HOOK}/`, import.meta.url);
  const names = async (dir: URL) =>
    (await readdir(dir, { withFileTypes: true })).map((e) => e.name).sort();
  expect(await names(copyDir)).toStrictEqual(await names(channelDir));
  for (const name of await names(channelDir)) {
    expect(await readFile(new URL(name, copyDir), "utf8"), name).toStrictEqual(
      await readFile(new URL(name, channelDir), "utf8"),
    );
  }
});
