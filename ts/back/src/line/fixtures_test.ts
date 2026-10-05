/**
 * Копии эталонов (вычислитель, хук `PreToolUse`) в `testdata/` обязаны совпадать с каналом
 * спецификаций байт-в-байт (`platform/evaluator.md`, «Golden-примеры»):
 * иначе тесты молча проходят на устаревшей копии.
 */

import { assertEquals } from "@std/assert";

const channel = new URL(
  "../../../docs/specs/fixtures/evaluator/cases.json",
  import.meta.url,
);
const copy = new URL("testdata/evaluator/cases.json", import.meta.url);

Deno.test("копия эталона вычислителя совпадает с каналом", async () => {
  assertEquals(
    await Deno.readTextFile(copy),
    await Deno.readTextFile(channel),
  );
});

/** Эталон хука `PreToolUse`: копии `testdata/` — те же файлы канала. */
const HOOK = "claude-hook-pre-tool-use";

Deno.test("копии эталона хука PreToolUse совпадают с каналом", async () => {
  const channelDir = new URL(
    `../../../docs/specs/fixtures/${HOOK}/`,
    import.meta.url,
  );
  const copyDir = new URL(`testdata/${HOOK}/`, import.meta.url);
  const names = async (dir: URL) =>
    (await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name).sort();
  assertEquals(await names(copyDir), await names(channelDir));
  for (const name of await names(channelDir)) {
    assertEquals(
      await Deno.readTextFile(new URL(name, copyDir)),
      await Deno.readTextFile(new URL(name, channelDir)),
      name,
    );
  }
});
