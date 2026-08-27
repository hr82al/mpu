/**
 * Солнце `mpu sun` (`docs/specs/sun.md`): счёт NOAA, форма ответа и
 * полярные исходы. Сети нет по построению — считается локально.
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { DomainError, UsageError } from "../command/mod.ts";
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
  return await Deno.readTextFile(
    new URL(`./testdata/sun/${name}`, import.meta.url),
  );
}

Deno.test("умолчания: офис, сегодня по Москве — эталон канала", async () => {
  // Дата у эталона задана флагом: умолчание — сегодняшний день, и
  // голден с ним протух бы назавтра.
  const result = sunOf(args({ date: "2026-08-27" }), NOW);
  assertEquals(
    sunCommand.renderResult(result, []),
    await golden("sun-stdout.txt"),
  );
});

Deno.test("поля идут в объявленном порядке", () => {
  assertEquals(Object.keys(sunOf(args({ date: "2026-08-27" }), NOW)), [
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

Deno.test("солнцестояния в Москве: день длиннее летом", async (t) => {
  const winter = sunOf(args({ date: "2026-12-21" }), NOW);
  const summer = sunOf(args({ date: "2026-06-21" }), NOW);

  await t.step("зимнее — около семи часов", () => {
    assertEquals(winter.day_length, "07:00:56");
    assertEquals(winter.sunrise, "2026-12-21 08:55:26");
    assertEquals(winter.sunset, "2026-12-21 15:56:22");
  });

  await t.step("летнее — около семнадцати с половиной", () => {
    assertEquals(summer.day_length, "17:32:31");
    assertEquals(summer.sunrise, "2026-06-21 03:43:33");
    assertEquals(summer.sunset, "2026-06-21 21:16:05");
  });

  await t.step("полдень обоих дней — около 12:30 МСК", () => {
    // Истинный полдень почти не гуляет: он определяется долготой и
    // уравнением времени, а не длиной дня.
    assertStringIncludes(winter.solar_noon, "12:25");
    assertStringIncludes(summer.solar_noon, "12:29");
  });
});

Deno.test("южное полушарие: в августе день короче ночи", () => {
  const sydney = sunOf(args({ lat: -33.8688, lon: 151.2093 }), NOW);
  // Времена — по Москве при любых координатах (контракт команды),
  // поэтому проверяется длина дня, а не часы восхода. Она чуть иная,
  // чем посчитанная в сиднейском поясе: московская дата отмеряет
  // другой участок суток, и склонение Солнца в нём другое.
  assertEquals(sydney.day_length, "11:12:52");
});

Deno.test("далёкая долгота: восход раньше заката, дата — своя", () => {
  // Сидней: московский день накрывает сиднейские сутки со сдвигом, и
  // восход приходится на предыдущие московские сутки. Момент несёт
  // свою дату — иначе ответ читался бы как «восход позже заката».
  const sydney = sunOf(
    args({ lat: -33.8688, lon: 151.2093, date: "2026-08-27" }),
    NOW,
  );
  assertEquals(sydney.date, "2026-08-27");
  assertEquals(sydney.sunrise, "2026-08-26 23:20:27");
  assertEquals(sydney.solar_noon, "2026-08-27 04:56:53");
  assertEquals(sydney.sunset, "2026-08-27 10:33:19");
  assertEquals(sydney.sunrise < sydney.solar_noon, true);
  assertEquals(sydney.solar_noon < sydney.sunset, true);
});

Deno.test("полярные день и ночь — отказ, а не NaN", async (t) => {
  const svalbard = { lat: 78.2232, lon: 15.6469 };

  await t.step("полярная ночь", () => {
    const err = assertThrows(
      () => sunOf(args({ ...svalbard, date: "2026-12-21" }), NOW),
      DomainError,
    );
    assertEquals(
      err.message,
      "солнце не восходит в этот день на этих координатах",
    );
  });

  await t.step("полярный день", () => {
    const err = assertThrows(
      () => sunOf(args({ ...svalbard, date: "2026-06-21" }), NOW),
      DomainError,
    );
    assertEquals(
      err.message,
      "солнце не заходит в этот день на этих координатах",
    );
  });

  await t.step("исходный класс — свой, не общий", () => {
    assertThrows(
      () =>
        solarDay({
          latitude: 78.2232,
          longitude: 15.6469,
          timezoneHours: 3,
          year: 2026,
          month: 12,
          day: 21,
        }),
      NoSunriseError,
    );
  });
});

Deno.test("плохая --date — ошибка ввода", async (t) => {
  const bad = ["27.08.2026", "2026-8-27", "2026-08-27T00:00", "вчера", ""];
  for (const value of bad) {
    await t.step(`отбивается '${value}'`, () => {
      const err = assertThrows(
        () => sunOf(args({ date: value }), NOW),
        UsageError,
      );
      assertEquals(err.message, `bad --date '${value}', expected YYYY-MM-DD`);
    });
  }
  await t.step("несуществующий день отбивается тем же текстом", () => {
    const err = assertThrows(
      () => sunOf(args({ date: "2026-02-31" }), NOW),
      UsageError,
    );
    assertEquals(err.message, "bad --date '2026-02-31', expected YYYY-MM-DD");
  });
});

Deno.test("координаты вне диапазона — ошибка ввода", async (t) => {
  await t.step("широта", () => {
    const err = assertThrows(() => sunOf(args({ lat: 91 }), NOW), UsageError);
    assertStringIncludes(err.message, "bad --lat '91'");
  });
  await t.step("долгота", () => {
    const err = assertThrows(() => sunOf(args({ lon: -181 }), NOW), UsageError);
    assertStringIncludes(err.message, "bad --lon '-181'");
  });
});

Deno.test("умолчание даты — по Москве, а не по машине", () => {
  // 2026-08-27T21:30Z — в Москве уже 28-е.
  assertEquals(sunOf(args(), Date.UTC(2026, 7, 27, 21, 30)).date, "2026-08-28");
  assertEquals(
    sunOf(args(), Date.UTC(2026, 7, 27, 20, 59)).date,
    "2026-08-27",
  );
});

Deno.test("длительность в сутки не сворачивается", () => {
  assertEquals(duration(1440), "24:00:00");
  assertEquals(duration(90.5), "01:30:30");
  assertEquals(duration(0), "00:00:00");
});
