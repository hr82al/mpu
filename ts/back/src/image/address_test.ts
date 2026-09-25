/** Адрес метода в `base:`/`files:` (`image-sync.md`, «Адрес метода»). */

import { assertEquals, assertThrows } from "@std/assert";
import { MethodAddress, Misaddressed } from "./address.ts";

Deno.test("адрес: разбор, называние методов, адрес метода", async (t) => {
  await t.step("kiten.mine называет mine и mine:", () => {
    const address = MethodAddress.parse("kiten.mine");
    assertEquals(address.names({ receiver: ["kiten"], name: "mine" }), true);
    assertEquals(address.names({ receiver: ["kiten"], name: "mine:" }), true);
    assertEquals(address.names({ receiver: ["kiten"], name: "mines" }), false);
    assertEquals(address.names({ receiver: ["sheet"], name: "mine" }), false);
  });
  await t.step("метод → адрес: таблица спеки", () => {
    const cases: readonly (readonly [readonly string[], string, string])[] = [
      [["kiten"], "cardsIn:", "kiten.cardsIn"],
      [["kiten"], "mine", "kiten.mine"],
      [["sheet"], "sum:with:", "sheet.sum:with"],
      [["kiten", "ls"], "column:", "kiten.ls.column"],
    ];
    for (const [receiver, name, text] of cases) {
      assertEquals(MethodAddress.of({ receiver, name }).text(), text);
      assertEquals(MethodAddress.parse(text).names({ receiver, name }), true);
    }
  });
  await t.step("не адрес — отказ с самим словом", () => {
    for (const word of ["cardsIn", ".cardsIn", "kiten.", "kiten..x"]) {
      const err = assertThrows(() => MethodAddress.parse(word), Misaddressed);
      assertEquals(err.message, `адрес метода — получатель.имя: ${word}`);
    }
  });
});
