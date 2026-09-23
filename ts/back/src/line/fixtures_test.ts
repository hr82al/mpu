/**
 * Копия эталона вычислителя в `testdata/` обязана совпадать с каналом
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
