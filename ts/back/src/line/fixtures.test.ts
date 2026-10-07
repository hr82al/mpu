/**
 * Копии эталонов (вычислитель, хук `PreToolUse`) в `testdata/` обязаны совпадать с каналом
 * спецификаций байт-в-байт (`platform/evaluator.md`, «Golden-примеры»):
 * иначе тесты молча проходят на устаревшей копии.
 */

import { readdir, readFile } from "node:fs/promises";
import { expect, it } from "vitest";

const channel = new URL(
  "../../../docs/specs/fixtures/evaluator/cases.json",
  import.meta.url,
);
const copy = new URL("testdata/evaluator/cases.json", import.meta.url);

it("копия эталона вычислителя совпадает с каналом", async () => {
  expect(await readFile(copy, "utf8")).toStrictEqual(
    await readFile(channel, "utf8"),
  );
});

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
