import { describe, expect, it } from "vitest";
import { thrown } from "../testing/thrown.ts";
import { EmptyRulePath, RulePath } from "./mod.ts";

describe("путь правила нормализуется", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["kiten  card *", "kiten card"],
    [" kiten\tcard ", "kiten card"],
    ["kiten *", "kiten"],
    ["*", "*"],
    ["* *", "*"],
    ["kiten card <args>", "kiten card <args>"],
  ];
  for (const [text, normal] of cases) {
    it(JSON.stringify(text), () => {
      expect(RulePath.parse(text).text()).toStrictEqual(normal);
    });
  }
});

it("пустой путь правила — отказ", () => {
  for (const text of ["", "   "]) {
    thrown(
      () => RulePath.parse(text),
      EmptyRulePath,
      "путь правила пуст",
    );
  }
});
