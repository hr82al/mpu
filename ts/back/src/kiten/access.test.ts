/**
 * Селектор карточки у слоя команд (`docs/specs/platform/kaiten-http.md`,
 * «Селектор карточки»; `docs/specs/platform/tslibs-kaiten.md`, [S.6]):
 * разбор — библиотеки `@mpu/kaiten`, а её отказ ввода здесь становится
 * ошибкой ввода команды (код 2) с прежним текстом.
 */

import { KaitenInputError } from "@mpu/kaiten";
import { thrown } from "@mpu/testing/thrown";
import { describe, expect, it } from "vitest";
import { UsageError } from "@mpu/command";
import { cardIdOf } from "./access.ts";

describe("cardIdOf: селектор карточки аргумента команды", () => {
  it("id из числа и из URL — как у библиотеки", () => {
    expect(cardIdOf("65634936")).toStrictEqual(65634936);
    expect(
      cardIdOf("https://btlz.kaiten.ru/space/286794/boards/card/65634936"),
    ).toStrictEqual(65634936);
  });

  it("нет id — ошибка ввода команды с прежним текстом, причина — отказ библиотеки", () => {
    const err = thrown(() => cardIdOf("abc"), UsageError);
    expect(err.message, "текст отказа — дословно прежний").toStrictEqual(
      "не удалось извлечь id карточки из 'abc'",
    );
    expect(
      err.cause instanceof KaitenInputError,
      "cause — отказ ввода библиотеки",
    ).toBe(true);
  });
});
