/** Адрес метода в `base:`/`files:` (`image-sync.md`, «Адрес метода»). */

import { describe, expect, it } from "vitest";
import { thrown } from "@mpu/testing/thrown";
import { MethodAddress, Misaddressed } from "./address.ts";

describe("адрес: разбор, называние методов, адрес метода", () => {
  it("kiten.mine называет mine и mine:", () => {
    const address = MethodAddress.parse("kiten.mine");
    expect(address.names({ receiver: ["kiten"], name: "mine" })).toBe(true);
    expect(address.names({ receiver: ["kiten"], name: "mine:" })).toBe(true);
    expect(address.names({ receiver: ["kiten"], name: "mines" })).toBe(false);
    expect(address.names({ receiver: ["sheet"], name: "mine" })).toBe(false);
  });
  it("метод → адрес: таблица спеки", () => {
    const cases: readonly (readonly [readonly string[], string, string])[] = [
      [["kiten"], "cardsIn:", "kiten.cardsIn"],
      [["kiten"], "mine", "kiten.mine"],
      [["sheet"], "sum:with:", "sheet.sum:with"],
      [["kiten", "ls"], "column:", "kiten.ls.column"],
    ];
    for (const [receiver, name, text] of cases) {
      expect(MethodAddress.of({ receiver, name }).text()).toStrictEqual(text);
      expect(MethodAddress.parse(text).names({ receiver, name })).toBe(true);
    }
  });
  it("не адрес — отказ с самим словом", () => {
    for (const word of ["cardsIn", ".cardsIn", "kiten.", "kiten..x"]) {
      const err = thrown(() => MethodAddress.parse(word), Misaddressed);
      expect(err.message).toStrictEqual(
        `адрес метода — получатель.имя: ${word}`,
      );
    }
  });
});
