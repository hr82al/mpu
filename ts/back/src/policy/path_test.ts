import { assertEquals, assertThrows } from "@std/assert";
import { EmptyRulePath, RulePath } from "./mod.ts";

Deno.test("путь правила нормализуется", async (t) => {
  const cases: readonly (readonly [string, string])[] = [
    ["kiten  card *", "kiten card"],
    [" kiten\tcard ", "kiten card"],
    ["kiten *", "kiten"],
    ["*", "*"],
    ["* *", "*"],
    ["kiten card <args>", "kiten card <args>"],
  ];
  for (const [text, normal] of cases) {
    await t.step(JSON.stringify(text), () => {
      assertEquals(RulePath.parse(text).text(), normal);
    });
  }
});

Deno.test("пустой путь правила — отказ", () => {
  for (const text of ["", "   "]) {
    assertThrows(
      () => RulePath.parse(text),
      EmptyRulePath,
      "путь правила пуст",
    );
  }
});
