/**
 * Копии golden-фикстур обязаны совпадать с каналом спецификаций
 * байт-в-байт (`docs/CLAUDE.md`).
 */

import { assertEquals } from "@std/assert";

const NAMES: readonly string[] = [
  "dry-run.stdout",
  "dry-run-no-image.stdout",
  "overrides/sl-base.observability-off.yaml",
  "overrides/sl-instance.observability-off.yaml",
  "overrides/sl-main.observability-off.yaml",
];
const copyDir = new URL("testdata/mp-init/", import.meta.url);

Deno.test("копии фикстур совпадают с каналом спецификаций", async (t) => {
  for (const name of NAMES) {
    await t.step(name, async () => {
      assertEquals(
        await Deno.readTextFile(new URL(name, copyDir)),
        await Deno.readTextFile(
          new URL(
            `../../../docs/specs/fixtures/mp-init/${name}`,
            import.meta.url,
          ),
        ),
      );
    });
  }
});

Deno.test("в testdata нет копий, которых нет в канале", async () => {
  const found: string[] = [];
  for await (const entry of Deno.readDir(copyDir)) {
    if (!entry.isDirectory) {
      found.push(entry.name);
      continue;
    }
    for await (
      const inner of Deno.readDir(new URL(`${entry.name}/`, copyDir))
    ) {
      found.push(`${entry.name}/${inner.name}`);
    }
  }
  assertEquals(found.sort(), [...NAMES].sort());
});
