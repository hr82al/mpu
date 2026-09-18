/**
 * Эталон выбора решения (`fixtures/policy/cases.json`): набор правил,
 * путь строки → решение и путь выигравшего правила. Копия в `testdata/`
 * обязана совпадать с каналом спецификаций байт-в-байт.
 */

import { assertEquals } from "@std/assert";
import { Rule, RulePath, Rules } from "./mod.ts";
import { verdictNamed } from "./verdict.ts";

interface Case {
  readonly name: string;
  readonly rules: readonly {
    readonly path: string;
    readonly verdict: string;
  }[];
  readonly path: string;
  readonly verdict: string;
  readonly won: string | null;
}

const copy = new URL("testdata/policy/cases.json", import.meta.url);
const channel = new URL(
  "../../../docs/specs/fixtures/policy/cases.json",
  import.meta.url,
);

Deno.test("копия эталона решений совпадает с каналом", async () => {
  assertEquals(await Deno.readTextFile(copy), await Deno.readTextFile(channel));
});

Deno.test("решение для пути строки по эталону", async (t) => {
  const { cases } = JSON.parse(await Deno.readTextFile(copy)) as {
    readonly cases: readonly Case[];
  };
  assertEquals(cases.length, 14);
  for (const one of cases) {
    await t.step(one.name, () => {
      const rules = new Rules(
        one.rules.map((rule) =>
          new Rule(RulePath.parse(rule.path), verdictNamed(rule.verdict))
        ),
      );
      assertEquals(rules.decide(one.path.split(" ")).record(), {
        verdict: one.verdict,
        won: one.won,
      });
    });
  }
});
