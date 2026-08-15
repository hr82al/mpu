/**
 * Разбор входа записей времени (`docs/specs/kiten-time.md`, «CLI-контракт»
 * и «Граничные случаи»). Тексты шести ветвей закрыты голденами канала;
 * пара `DURATION`/`--time` проверяется именно парой — она и показывает,
 * что префикс называет аргумент, через который пришло значение.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { UsageError } from "../command/mod.ts";
import { mskToday, parseCalendarDate, parseDuration } from "./time_input.ts";

function golden(name: string): Promise<string> {
  return Deno.readTextFile(
    new URL(`testdata/kiten-time/${name}`, import.meta.url),
  );
}

/** Текст ошибки одной строкой: голдены сообщений хранятся с `\n`. */
function messageOf(call: () => unknown): string {
  return `${assertThrows(call, UsageError).message}\n`;
}

Deno.test("parseDuration: принятые формы дают целые минуты", async (t) => {
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
    await t.step(`${input} → ${minutes}`, () => {
      assertEquals(parseDuration(input, "DURATION"), minutes);
    });
  }
});

Deno.test("parseDuration: тексты ошибок — голдены канала", async (t) => {
  await t.step("ноль", async () => {
    assertEquals(
      messageOf(() => parseDuration("0", "DURATION")),
      await golden("err-duration-zero-message.txt"),
    );
  });

  await t.step("ноль у --time: префикс называет флаг", async () => {
    assertEquals(
      messageOf(() => parseDuration("0", "--time")),
      await golden("err-edit-duration-zero-message.txt"),
    );
  });

  await t.step("пробелы — своя ветвь, не «неразобранная»", async () => {
    assertEquals(
      messageOf(() => parseDuration("  ", "DURATION")),
      await golden("err-duration-empty-message.txt"),
    );
  });

  await t.step("число без единицы в хвосте", async () => {
    assertEquals(
      messageOf(() => parseDuration("1h15", "DURATION")),
      await golden("err-duration-tail-message.txt"),
    );
  });

  await t.step("буква подсказки — из алфавита входа", () => {
    assertEquals(
      messageOf(() => parseDuration("1ч15", "DURATION")),
      "DURATION '1ч15': после числа нужна единица измерения — вероятно, " +
        "вы имели в виду '1ч15м'\n",
    );
  });

  await t.step("минуты формы Ч:ММ вне 00–59", async () => {
    assertEquals(
      messageOf(() => parseDuration("1:60", "DURATION")),
      await golden("err-duration-minutes-message.txt"),
    );
  });
});

Deno.test("parseDuration: остальные отказы", async (t) => {
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
    await t.step(input, () => {
      assertEquals(
        messageOf(() => parseDuration(input, "DURATION")),
        `DURATION '${input}': ${reason}\n`,
      );
    });
  }
});

Deno.test("parseCalendarDate: строго YYYY-MM-DD", async (t) => {
  await t.step("валидная дата возвращается как есть", () => {
    assertEquals(parseCalendarDate("2026-08-15", "--date"), "2026-08-15");
  });

  await t.step("текст отказа — голден канала", async () => {
    assertEquals(
      messageOf(() => parseCalendarDate("15.08.2026", "--date")),
      await golden("err-date-format-message.txt"),
    );
  });

  const bad = ["2026-8-15", "2026-02-30", "2026-13-01", "", "2026-08-15T00:00"];
  for (const input of bad) {
    await t.step(`отвергнуто: '${input}'`, () => {
      assertEquals(
        messageOf(() => parseCalendarDate(input, "--date-from")),
        `--date-from='${input}': ожидается YYYY-MM-DD\n`,
      );
    });
  }
});

Deno.test("mskToday: день по МСК, не по зоне машины", async (t) => {
  const cases: readonly [string, string][] = [
    // 23:30 UTC 14-го — в Москве уже 15-е.
    ["2026-08-14T23:30:00Z", "2026-08-15"],
    // 20:59 UTC 14-го — в Москве ещё 14-е.
    ["2026-08-14T20:59:59Z", "2026-08-14"],
    ["2026-08-15T00:00:00Z", "2026-08-15"],
  ];
  for (const [iso, day] of cases) {
    await t.step(`${iso} → ${day}`, () => {
      assertEquals(mskToday(Date.parse(iso)), day);
    });
  }
});
