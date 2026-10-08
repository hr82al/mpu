/**
 * Солнце `mpu sun` (`docs/specs/sun.md`): счёт NOAA, форма ответа и
 * полярные исходы. Сети нет по построению — считается локально.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { thrown } from "@mpu/testing/thrown";
import { DomainError, UsageError } from "@mpu/command";
import { sunCommand, sunOf } from "./cmd_sun.ts";
import { duration, NoSunriseError, solarDay } from "./noaa.ts";

/** Полдень 27 августа 2026 по МСК: точка отсчёта умолчаний. */
const NOW = Date.UTC(2026, 7, 27, 9, 0);

const args = (overrides: Record<string, unknown> = {}) => ({
  lat: 55.693516,
  lon: 37.967941,
  date: undefined,
  ...overrides,
});

async function golden(name: string): Promise<string> {
  return await readFile(
    new URL(`./testdata/sun/${name}`, import.meta.url),
    "utf8",
  );
}

it("умолчания: офис, сегодня по Москве — эталон канала", async () => {
  // Дата у эталона задана флагом: умолчание — сегодняшний день, и
  // голден с ним протух бы назавтра.
  const result = sunOf(args({ date: "2026-08-27" }), NOW);
  expect(sunCommand.renderResult(result, [])).toStrictEqual(
    await golden("sun-stdout.txt"),
  );
});

it("поля идут в объявленном порядке", () => {
  expect(Object.keys(sunOf(args({ date: "2026-08-27" }), NOW))).toStrictEqual([
    "date",
    "latitude",
    "longitude",
    "timezone",
    "sunrise",
    "solar_noon",
    "sunset",
    "day_length",
  ]);
});

describe("солнцестояния в Москве: день длиннее летом", () => {
  const winter = sunOf(args({ date: "2026-12-21" }), NOW);
  const summer = sunOf(args({ date: "2026-06-21" }), NOW);

  it("зимнее — около семи часов", () => {
    expect(winter.day_length).toBe("07:01:02");
    expect(winter.sunrise).toBe("2026-12-21 08:55:38");
    expect(winter.sunset).toBe("2026-12-21 15:56:40");
  });

  it("летнее — около семнадцати с половиной", () => {
    expect(summer.day_length).toBe("17:32:41");
    expect(summer.sunrise).toBe("2026-06-21 03:43:35");
    expect(summer.sunset).toBe("2026-06-21 21:16:16");
  });

  it("полдень обоих дней — около 12:30 МСК", () => {
    // Истинный полдень почти не гуляет: он определяется долготой и
    // уравнением времени, а не длиной дня.
    expect(winter.solar_noon).toContain("12:26");
    expect(summer.solar_noon).toContain("12:29");
  });
});

it("южное полушарие: в августе день короче ночи", () => {
  const sydney = sunOf(args({ lat: -33.8688, lon: 151.2093 }), NOW);
  // Времена — по Москве при любых координатах (контракт команды),
  // поэтому проверяется длина дня, а не часы восхода. Она чуть иная,
  // чем посчитанная в сиднейском поясе: московская дата отмеряет
  // другой участок суток, и склонение Солнца в нём другое.
  expect(sydney.day_length).toBe("11:13:08");
});

it("далёкая долгота: восход раньше заката, дата — своя", () => {
  // Сидней: московский день накрывает сиднейские сутки со сдвигом, и
  // восход приходится на предыдущие московские сутки. Момент несёт
  // свою дату — иначе ответ читался бы как «восход позже заката».
  const sydney = sunOf(
    args({ lat: -33.8688, lon: 151.2093, date: "2026-08-27" }),
    NOW,
  );
  expect(sydney.date).toBe("2026-08-27");
  expect(sydney.sunrise).toBe("2026-08-26 23:20:29");
  expect(sydney.solar_noon).toBe("2026-08-27 04:56:49");
  expect(sydney.sunset).toBe("2026-08-27 10:33:37");
  expect(sydney.sunrise < sydney.solar_noon).toBe(true);
  expect(sydney.solar_noon < sydney.sunset).toBe(true);
});

describe("полярные день и ночь — отказ, а не NaN", () => {
  const svalbard = { lat: 78.2232, lon: 15.6469 };

  it("полярная ночь", () => {
    const err = thrown(
      () => sunOf(args({ ...svalbard, date: "2026-12-21" }), NOW),
      DomainError,
    );
    expect(err.message).toBe(
      "солнце не восходит в этот день на этих координатах",
    );
  });

  it("полярный день", () => {
    const err = thrown(
      () => sunOf(args({ ...svalbard, date: "2026-06-21" }), NOW),
      DomainError,
    );
    expect(err.message).toBe(
      "солнце не заходит в этот день на этих координатах",
    );
  });

  it("исходный класс — свой, не общий", () => {
    expect(() =>
      solarDay({
        latitude: 78.2232,
        longitude: 15.6469,
        timezoneHours: 3,
        year: 2026,
        month: 12,
        day: 21,
      }),
    ).toThrow(NoSunriseError);
  });
});

describe("плохая --date — ошибка ввода", () => {
  const bad = ["27.08.2026", "2026-8-27", "2026-08-27T00:00", "вчера", ""];
  for (const value of bad) {
    it(`отбивается '${value}'`, () => {
      const err = thrown(() => sunOf(args({ date: value }), NOW), UsageError);
      expect(err.message).toStrictEqual(
        `bad --date '${value}', expected YYYY-MM-DD`,
      );
    });
  }
  it("несуществующий день отбивается тем же текстом", () => {
    const err = thrown(
      () => sunOf(args({ date: "2026-02-31" }), NOW),
      UsageError,
    );
    expect(err.message).toBe("bad --date '2026-02-31', expected YYYY-MM-DD");
  });
});

describe("координаты вне диапазона — ошибка ввода", () => {
  it("широта", () => {
    const err = thrown(() => sunOf(args({ lat: 91 }), NOW), UsageError);
    expect(err.message).toContain("bad --lat '91'");
  });
  it("долгота", () => {
    const err = thrown(() => sunOf(args({ lon: -181 }), NOW), UsageError);
    expect(err.message).toContain("bad --lon '-181'");
  });
});

it("умолчание даты — по Москве, а не по машине", () => {
  // 2026-08-27T21:30Z — в Москве уже 28-е.
  expect(sunOf(args(), Date.UTC(2026, 7, 27, 21, 30)).date).toBe("2026-08-28");
  expect(sunOf(args(), Date.UTC(2026, 7, 27, 20, 59)).date).toBe("2026-08-27");
});

it("положение берётся в момент события, а не в полночь", () => {
  // Половины дня неравны: за сутки склонение уходит на треть градуса.
  // Равные половины означали бы, что склонение взято один раз на всё
  // — ровно та ошибка, из-за которой закат уезжал на две минуты.
  const day = sunOf(args({ date: "2026-08-27" }), NOW);
  const seconds = (time: string) => {
    const [h, m, s] = time.slice(11).split(":").map(Number);
    return h * 3600 + m * 60 + s;
  };
  const morning = seconds(day.solar_noon) - seconds(day.sunrise);
  const evening = seconds(day.sunset) - seconds(day.solar_noon);
  expect(morning !== evening, "половины дня совпали").toBe(true);
  // И расходятся они на десятки секунд, а не на часы: это поправка, а
  // не другой алгоритм.
  expect(Math.abs(morning - evening) < 120).toBe(true);
});

it("длительность в сутки не сворачивается", () => {
  expect(duration(1440)).toBe("24:00:00");
  expect(duration(90.5)).toBe("01:30:30");
  expect(duration(0)).toBe("00:00:00");
});
