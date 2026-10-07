/** Случаи эталона `cases.json` на тестовом дереве. */

import { describe, expect, it } from "vitest";
import { GRAMMAR } from "../messages/mod.ts";
import golden from "./testdata/objects/cases.json" with { type: "json" };
import { runChain } from "./mod.ts";
import { said, testTree } from "./testtree.ts";

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

it("в эталоне объектов 43 случая", () => {
  expect(golden.cases.length).toBe(43);
});

describe("случаи эталона объектов", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const outcome = await runChain(c.words.map(word), testTree().root);
      if (c.error !== undefined) {
        expect(said(outcome)).toStrictEqual({
          error: unmarked(c.error),
          code: 2,
        });
        return;
      }
      if (c.value_file !== undefined) {
        const value = await helpText(c.value_file);
        expect(outcome).toStrictEqual({ path: c.path, value });
        return;
      }
      if (c.object_file !== undefined) {
        const object = await helpText(c.object_file);
        expect(outcome).toStrictEqual({ path: c.path, object });
        return;
      }
      expect(outcome).toStrictEqual({ path: c.path, value: c.value });
    });
  }
});
