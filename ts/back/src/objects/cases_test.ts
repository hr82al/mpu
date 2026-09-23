/**
 * Случаи эталона `cases.json` на тестовом дереве. Исполнению прав не
 * даётся никаких, кроме чтения эталонов справки самим тестом.
 */

import { assertEquals } from "@std/assert";
import { GRAMMAR } from "../messages/mod.ts";
import golden from "./testdata/objects/cases.json" with { type: "json" };
import { runChain } from "./mod.ts";
import { testTree } from "./testtree.ts";

const helpDir = new URL("testdata/objects/", import.meta.url);

/**
 * Слова грамматики в эталоне — метками: эталон не зависит от того, как
 * они пишутся (`platform/line-grammar.md` [D.1]).
 */
const MARKS: Readonly<Record<string, string>> = {
  $open: GRAMMAR.open,
  $close: GRAMMAR.close,
  $literal: GRAMMAR.literal,
};

/** Слово эталона: метка — слово грамматики, в том числе с двоеточием. */
function word(text: string): string {
  const bare = text.endsWith(":") ? text.slice(0, -1) : text;
  const known = MARKS[bare];
  if (known === undefined) return text;
  return text.endsWith(":") ? `${known}:` : known;
}

function unmarked(text: string): string {
  return text.split(" ").map(word).join(" ");
}

function helpText(name: string): Promise<string> {
  return Deno.readTextFile(new URL(name, helpDir));
}

Deno.test("в эталоне объектов 43 случая", () => {
  assertEquals(golden.cases.length, 43);
});

Deno.test({
  name: "случаи эталона объектов",
  permissions: { read: [helpDir] },
  async fn(t) {
    for (const c of golden.cases) {
      await t.step(c.name, async () => {
        const outcome = await runChain(c.words.map(word), testTree().root);
        if (c.error !== undefined) {
          assertEquals(outcome, { error: unmarked(c.error), code: 2 });
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
