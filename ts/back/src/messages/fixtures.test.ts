/**
 * Копия эталона в `testdata/` обязана совпадать с каналом спецификаций
 * байт-в-байт: иначе тесты молча проходят на устаревшей копии.
 */

import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const FIXTURES: readonly string[] = ["cases.json"];

const channelDir = new URL(
  "../../../docs/specs/fixtures/messages/",
  import.meta.url,
);
const copyDir = new URL("testdata/messages/", import.meta.url);

describe("копия эталона сообщений совпадает с каналом", () => {
  for (const name of FIXTURES) {
    it(name, async () => {
      expect(await readFile(new URL(name, copyDir), "utf8")).toStrictEqual(
        await readFile(new URL(name, channelDir), "utf8"),
      );
    });
  }
});

it("в testdata сообщений нет копий, которых нет в канале", async () => {
  const copied: string[] = [];
  for (const entry of await readdir(copyDir, { withFileTypes: true })) {
    copied.push(entry.name);
  }
  expect(copied.sort()).toStrictEqual([...FIXTURES].sort());
});
