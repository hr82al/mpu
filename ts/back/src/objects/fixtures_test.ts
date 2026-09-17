/**
 * Копии эталонов объектов в `testdata/` обязаны совпадать с каналом
 * спецификаций байт-в-байт.
 */

import { assertEquals } from "@std/assert";

const FIXTURES: readonly string[] = [
  "cases.json",
  "help-card-keyword.txt",
  "help-card-word-abc.txt",
  "help-card-word.txt",
  "help-comment.txt",
  "help-kiten-card.txt",
  "help-kiten-ls.txt",
  "help-kiten.txt",
  "help-root.txt",
  "help-version.txt",
];

const channelDir = new URL(
  "../../../docs/specs/fixtures/objects/",
  import.meta.url,
);
const copyDir = new URL("testdata/objects/", import.meta.url);

Deno.test("копии эталонов объектов совпадают с каналом", async (t) => {
  for (const name of FIXTURES) {
    await t.step(name, async () => {
      assertEquals(
        await Deno.readTextFile(new URL(name, copyDir)),
        await Deno.readTextFile(new URL(name, channelDir)),
      );
    });
  }
});

Deno.test("в testdata объектов нет копий, которых нет в канале", async () => {
  const copied: string[] = [];
  for await (const entry of Deno.readDir(copyDir)) {
    copied.push(entry.name);
  }
  assertEquals(copied.sort(), [...FIXTURES].sort());
});
