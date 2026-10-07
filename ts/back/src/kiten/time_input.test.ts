/**
 * Разбор входа записей времени (`docs/specs/kiten-time.md`, «CLI-контракт»
 * и «Граничные случаи»). Тексты шести ветвей закрыты голденами канала;
 * пара `DURATION`/`--time` проверяется именно парой — она и показывает,
 * что префикс называет аргумент, через который пришло значение.
 */

import { readFile } from "node:fs/promises";
import { assert, describe, expect, it } from "vitest";
import { UsageError } from "../command/mod.ts";
import { parseCalendarDate, parseDuration } from "./time_input.ts";

function golden(name: string): Promise<string> {
  return readFile(
    new URL(`testdata/kiten-time/${name}`, import.meta.url),
    "utf8",
  );
}

/** Текст ошибки одной строкой: голдены сообщений хранятся с `\n`. */
function messageOf(call: () => unknown): string {
  let err: unknown;
  try {
    call();
  } catch (e) {
    err = e;
  }
  assert(err instanceof UsageError, "ожидался отказ UsageError");
  return `${err.message}\n`;
}

describe("parseDuration: принятые формы дают целые минуты", () => {
  const cases: readonly [string, number][] = [
    ["3h", 180],
    ["1h15m", 75],
    ["1:15", 75],
    ["90", 90],
    ["2.5h", 150],
    ["2,5h", 150],
    ["1ч15м", 75],
    ["1H 15M", 75],
    ["  45  ", 45],
    ["0:45", 45],
    ["24h", 1440],
    ["1", 1],
    // Дробь округляется вверх до минуты, а не до ближайшей.
    ["2.51h", 151],
    ["0.4", 1],
    // Ровное значение остаётся ровным: шум двоичной дроби (1.1 × 60 =
    // 66.00000000000001) не должен превращаться в лишнюю минуту.
    ["1.1h", 66],
  ];
  for (const [input, minutes] of cases) {
    it(`${input} → ${minutes}`, () => {
      expect(parseDuration(input, "DURATION")).toStrictEqual(minutes);
    });
  }
});

describe("parseDuration: тексты ошибок — голдены канала", () => {
  it("ноль", async () => {
    expect(messageOf(() => parseDuration("0", "DURATION"))).toStrictEqual(
      await golden("err-duration-zero-message.txt"),
    );
  });

  it("ноль у --time: префикс называет флаг", async () => {
    expect(messageOf(() => parseDuration("0", "--time"))).toStrictEqual(
      await golden("err-edit-duration-zero-message.txt"),
    );
  });

  it("пробелы — своя ветвь, не «неразобранная»", async () => {
    expect(messageOf(() => parseDuration("  ", "DURATION"))).toStrictEqual(
      await golden("err-duration-empty-message.txt"),
    );
  });

  it("число без единицы в хвосте", async () => {
    expect(messageOf(() => parseDuration("1h15", "DURATION"))).toStrictEqual(
      await golden("err-duration-tail-message.txt"),
    );
  });

  it("буква подсказки — из алфавита входа", () => {
    expect(messageOf(() => parseDuration("1ч15", "DURATION"))).toStrictEqual(
      "DURATION '1ч15': после числа нужна единица измерения — вероятно, " +
        "вы имели в виду '1ч15м'\n",
    );
  });

  it("минуты формы Ч:ММ вне 00–59", async () => {
    expect(messageOf(() => parseDuration("1:60", "DURATION"))).toStrictEqual(
      await golden("err-duration-minutes-message.txt"),
    );
  });
});

describe("parseDuration: остальные отказы", () => {
  const cases: readonly [string, string][] = [
    ["-5", "нулевая длительность бессмысленна"],
    ["0m", "нулевая длительность бессмысленна"],
    [
      "1441",
      "больше 24 ч в одной записи; заведите записи по дням через --date",
    ],
    [
      "25h",
      "больше 24 ч в одной записи; заведите записи по дням через --date",
    ],
    [
      "мусор",
      "неразобранная длительность; ожидается 3h | 1h15m | 1:15 | 90 (минуты) | 2.5h",
    ],
    [
      "1h-15m",
      "неразобранная длительность; ожидается 3h | 1h15m | 1:15 | 90 (минуты) | 2.5h",
    ],
    [
      "1e2",
      "неразобранная длительность; ожидается 3h | 1h15m | 1:15 | 90 (минуты) | 2.5h",
    ],
    [
      "15m1",
      "неразобранная длительность; ожидается 3h | 1h15m | 1:15 | 90 (минуты) | 2.5h",
    ],
    [
      "1h2h",
      "неразобранная длительность; ожидается 3h | 1h15m | 1:15 | 90 (минуты) | 2.5h",
    ],
  ];
  for (const [input, reason] of cases) {
    it(input, () => {
      expect(messageOf(() => parseDuration(input, "DURATION"))).toStrictEqual(
        `DURATION '${input}': ${reason}\n`,
      );
    });
  }
});

describe("parseCalendarDate: строго YYYY-MM-DD", () => {
  it("валидная дата возвращается как есть", () => {
    expect(parseCalendarDate("2026-08-15", "--date")).toBe("2026-08-15");
  });

  it("текст отказа — голден канала", async () => {
    expect(messageOf(() => parseCalendarDate("15.08.2026", "--date")))
      .toStrictEqual(await golden("err-date-format-message.txt"));
  });

  const bad = ["2026-8-15", "2026-02-30", "2026-13-01", "", "2026-08-15T00:00"];
  for (const input of bad) {
    it(`отвергнуто: '${input}'`, () => {
      expect(messageOf(() => parseCalendarDate(input, "--date-from")))
        .toStrictEqual(`--date-from='${input}': ожидается YYYY-MM-DD\n`);
    });
  }
});
