/**
 * Эталон выбора решения (`fixtures/policy/cases.json`): набор правил,
 * путь строки → решение и путь выигравшего правила. Копия в `testdata/`
 * обязана совпадать с каналом спецификаций байт-в-байт.
 */

import { readFile } from "node:fs/promises";
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

const copy = new URL("testdata/policy/cases.json", import.meta.url);
const channel = new URL(
  "../../../docs/specs/fixtures/policy/cases.json",
  import.meta.url,
);

it("копия эталона решений совпадает с каналом", async () => {
  expect(await readFile(copy, "utf8")).toStrictEqual(
    await readFile(channel, "utf8"),
  );
});

describe("решение для пути строки по эталону", () => {
  const cases: readonly Case[] = golden.cases;
  beforeAll(() => {
    expect(cases.length).toBe(14);
  });
  for (const one of cases) {
    it(one.name, () => {
      const rules = new Rules(
        one.rules.map((rule) =>
          new Rule(RulePath.parse(rule.path), verdictNamed(rule.verdict))
        ),
      );
      expect(rules.decide(one.path.split(" ")).record()).toStrictEqual({
        verdict: one.verdict,
        won: one.won,
      });
    });
  }
});
