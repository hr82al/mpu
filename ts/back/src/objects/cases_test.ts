/**
 * Случаи эталона `cases.json` на тестовом дереве. Исполнению прав не
 * даётся никаких, кроме чтения эталонов справки самим тестом.
 */

import { assertEquals } from "@std/assert";
import golden from "./testdata/objects/cases.json" with { type: "json" };
import { runChain } from "./mod.ts";
import { testTree } from "./testtree.ts";

const helpDir = new URL("testdata/objects/", import.meta.url);

function helpText(name: string): Promise<string> {
  return Deno.readTextFile(new URL(name, helpDir));
}

Deno.test("в эталоне объектов 42 случая", () => {
  assertEquals(golden.cases.length, 42);
});

Deno.test({
  name: "случаи эталона объектов",
  permissions: { read: [helpDir] },
  async fn(t) {
    for (const c of golden.cases) {
      await t.step(c.name, async () => {
        const outcome = await runChain(c.words, testTree().root);
        if (c.error !== undefined) {
          assertEquals(outcome, { error: c.error, code: 2 });
          return;
        }
        if (c.value_file !== undefined) {
          const value = await helpText(c.value_file);
          assertEquals(outcome, { path: c.path, value });
          return;
        }
        if (c.object_file !== undefined) {
          const object = await helpText(c.object_file);
          assertEquals(outcome, { path: c.path, object });
          return;
        }
        assertEquals(outcome, { path: c.path, value: c.value });
      });
    }
  },
});
