/**
 * Юнит-тесты `localDate` (`./dates.ts`): вся суть функции — граничный
 * переход через полночь при разных знаках смещения, поэтому даты
 * подобраны так, чтобы UTC-дата момента и локальная дата разошлись.
 */

import { assertEquals } from "@std/assert";
import { localDate } from "./dates.ts";

Deno.test("localDate: граница полуночи по смещению", async (t) => {
  await t.step("положительное смещение (запад) — дата на сутки раньше", () => {
    // offsetMinutes=300 — пояс западнее Гринвича на 5 часов (UTC-5).
    // Момент — начало UTC-суток, локально ещё вчерашний вечер.
    const nowMs = Date.parse("2026-02-01T04:30:00.000Z");
    assertEquals(localDate(nowMs, 300), "2026-01-31");
  });

  await t.step(
    "отрицательное смещение (восток, МСК) — дата на сутки позже",
    () => {
      // offsetMinutes=-180 — пояс восточнее Гринвича на 3 часа (UTC+3).
      // Момент — конец UTC-суток, локально уже завтрашняя ночь.
      const nowMs = Date.parse("2026-01-31T22:30:00.000Z");
      assertEquals(localDate(nowMs, -180), "2026-02-01");
    },
  );

  await t.step("нулевое смещение — локальная дата равна UTC-дате", () => {
    const nowMs = Date.parse("2026-01-31T22:30:00.000Z");
    assertEquals(localDate(nowMs, 0), "2026-01-31");
  });
});
