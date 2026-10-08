/**
 * Эталон выбора решения (`fixtures/policy/cases.json`): набор правил,
 * путь строки → решение и путь выигравшего правила. Копия в `testdata/` —
 * байт-в-байт с каналом; как она меняется — `CLAUDE.md` пакета,
 * «Раскладка».
 */

import { beforeAll, describe, expect, it } from "vitest";
import { Rule, RulePath, Rules } from "./mod.ts";
import { verdictNamed } from "./verdict.ts";
import golden from "./testdata/policy/cases.json" with { type: "json" };

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

describe("решение для пути строки по эталону", () => {
  const cases: readonly Case[] = golden.cases;
  beforeAll(() => {
    expect(cases.length).toBe(14);
  });
  for (const one of cases) {
    it(one.name, () => {
      const rules = new Rules(
        one.rules.map(
          (rule) =>
            new Rule(RulePath.parse(rule.path), verdictNamed(rule.verdict)),
        ),
      );
      expect(rules.decide(one.path.split(" ")).record()).toStrictEqual({
        verdict: one.verdict,
        won: one.won,
      });
    });
  }
});
