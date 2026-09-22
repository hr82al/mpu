/**
 * Подсказки к слову за значением ключа (`platform/line-grammar.md`,
 * «Отказы с подсказкой»): строка вызова целиком, слово с пробелом — в
 * кавычках.
 */

import { assertEquals } from "@std/assert";
import { GRAMMAR, HELP_FLAG } from "../messages/mod.ts";
import { remedyFor } from "./remedy.ts";

Deno.test("подсказки к слову за значением", async (t) => {
  const address = "mpu sql-ro";
  const taken = ["sql:", "select 1"];
  const cases: readonly (readonly [string, string])[] = [
    [
      "md",
      `; формат — после ${GRAMMAR.close}: mpu sql-ro sql: "select 1" ` +
      `${GRAMMAR.close} md`,
    ],
    ["help", "; справка — последним словом: mpu sql-ro help"],
    [HELP_FLAG, "; справка — последним словом: mpu sql-ro help"],
    ["xml", ""],
  ];
  for (const [word, hint] of cases) {
    await t.step(word, () => {
      assertEquals(remedyFor(word, ["json", "md"]).spell(address, taken), hint);
    });
  }
});
