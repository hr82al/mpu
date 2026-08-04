/**
 * Копии golden-фикстур в `testdata/` обязаны совпадать с каналом
 * спецификаций байт-в-байт. Копия здесь даёт самодостаточность теста —
 * в отличие от закрытого списка публикации, который код импортирует из
 * канала напрямую и потому копии не имеет (`docs/CLAUDE.md`). Без этой сверки расхождение молчит: тесты продолжают
 * проходить на устаревшей копии, а обновлённый эталон канала никто не
 * читает — так и вышло между двумя задачами, правку нашли руками.
 *
 * Тест на файл, а не на каталог: имя разошедшегося эталона должно быть
 * видно из отчёта, без запуска diff'а вручную.
 */

import { assertEquals } from "@std/assert";

/** Пары «запрос → ответ», скопированные в testdata модуля. */
const FIXTURES: readonly string[] = [
  "discover-ok.json",
  "err-header-mismatch.json",
  "err-method-not-allowed.json",
  "err-unknown-method.json",
  "tools-call-domain-error.json",
  "tools-call-invalid-args.json",
  "tools-call-ok.json",
  "tools-list-ok.json",
];

const channelDir = new URL(
  "../../docs/specs/fixtures/mcp-server/",
  import.meta.url,
);
const copyDir = new URL("testdata/", import.meta.url);

Deno.test("копии фикстур совпадают с каналом спецификаций", async (t) => {
  for (const name of FIXTURES) {
    await t.step(name, async () => {
      assertEquals(
        await Deno.readTextFile(new URL(name, copyDir)),
        await Deno.readTextFile(new URL(name, channelDir)),
      );
    });
  }
});

Deno.test("в testdata нет копий, которых нет в канале", async () => {
  const copied: string[] = [];
  for await (const entry of Deno.readDir(copyDir)) {
    // Снапшоты `tools/list` — не копии канала, а эталоны реализации.
    if (
      entry.name.startsWith("tools-ro") || entry.name.startsWith("tools-rw")
    ) {
      continue;
    }
    copied.push(entry.name);
  }
  assertEquals(copied.sort(), [...FIXTURES].sort());
});
