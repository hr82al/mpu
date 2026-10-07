/**
 * Разбор селектора карточки (`docs/specs/platform/kaiten-http.md`,
 * раздел «Селектор карточки»): голый id, id из URL и отказ с точным
 * текстом спеки. Сети разбор не касается (инвариант атома), поэтому
 * тест — табличный и без сервера.
 */

import { describe, expect, it } from "vitest";
import { UsageError } from "../command/mod.ts";
import { parseCardRef } from "./mod.ts";

describe("parseCardRef: голый id и id из URL", () => {
  const cases: readonly (readonly [string, string, number])[] = [
    ["строка из одних цифр", "65634936", 65634936],
    [
      "URL: последний числовой сегмент, а не первый",
      "https://btlz.kaiten.ru/space/286794/boards/card/65634936",
      65634936,
    ],
    ["URL из одного сегмента", "https://btlz.kaiten.ru/65634936", 65634936],
    [
      "query и fragment отброшены",
      "https://btlz.kaiten.ru/space/286794/card/65634936?tab=files#c12345",
      65634936,
    ],
    [
      "хвостовой слэш не мешает",
      "https://btlz.kaiten.ru/space/286794/",
      286794,
    ],
    [
      "сегмент из цифр с буквами полностью числовым не считается",
      "https://btlz.kaiten.ru/cards/65634936/tab2",
      65634936,
    ],
  ];

  for (const [name, ref, expected] of cases) {
    it(name, () => {
      expect(parseCardRef(ref)).toStrictEqual(expected);
    });
  }
});

describe("parseCardRef: числового сегмента нет — ошибка ввода", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["не URL и не число", "карточка"],
    ["URL без числовых сегментов", "https://btlz.kaiten.ru/space/dev/card"],
    ["пустая строка", ""],
    ["цифры с пробелами", " 65634936 "],
  ];

  for (const [name, ref] of cases) {
    it(name, () => {
      expect(() => parseCardRef(ref)).toThrow(UsageError);
      expect(() => parseCardRef(ref)).toThrow(
        `не удалось извлечь id карточки из '${ref}'`,
      );
    });
  }
});
