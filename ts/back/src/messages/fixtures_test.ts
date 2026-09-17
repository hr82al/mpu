/**
 * Копия эталона в `testdata/` обязана совпадать с каналом спецификаций
 * байт-в-байт: иначе тесты молча проходят на устаревшей копии.
 */

import { assertEquals } from "@std/assert";

const FIXTURES: readonly string[] = ["cases.json"];

const channelDir = new URL(
  "../../../docs/specs/fixtures/messages/",
  import.meta.url,
);
const copyDir = new URL("testdata/messages/", import.meta.url);

Deno.test("копия эталона сообщений совпадает с каналом", async (t) => {
  for (const name of FIXTURES) {
    await t.step(name, async () => {
      assertEquals(
        await Deno.readTextFile(new URL(name, copyDir)),
        await Deno.readTextFile(new URL(name, channelDir)),
      );
    });
  }
});

Deno.test("в testdata сообщений нет копий, которых нет в канале", async () => {
  const copied: string[] = [];
  for await (const entry of Deno.readDir(copyDir)) {
    copied.push(entry.name);
  }
  assertEquals(copied.sort(), [...FIXTURES].sort());
});
