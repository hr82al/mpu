/**
 * Метки времени таймера (`docs/specs/kiten-time.md`, «Побочные эффекты»;
 * `platform/kaiten-api-time.md`, вызов 7). Под проверкой две
 * неочевидности обмена: зона метки берётся у момента старта, а
 * миллисекунды в отправляемых метках всегда `.000`.
 */

import { assertEquals } from "@std/assert";
import {
  elapsedMinutes,
  floorToMinute,
  isoAt,
  shiftMinutes,
  zoneOffsetMinutes,
} from "./timer_stamp.ts";

Deno.test("zoneOffsetMinutes: зона из хвоста метки", async (t) => {
  const cases: readonly [string, number | null][] = [
    ["2026-08-14T19:50:33.000+03:00", 180],
    ["2026-08-14T19:50:33.000+0300", 180],
    ["2026-08-14T16:50:33.000Z", 0],
    ["2026-08-14T11:20:33.000-05:30", -330],
    // Зоны в метке нет — вывести её неоткуда, и модуль её не выдумывает.
    ["2026-08-14T19:50:33.000", null],
    ["", null],
  ];
  for (const [iso, offset] of cases) {
    await t.step(`${iso || "(пусто)"} → ${offset}`, () => {
      assertEquals(zoneOffsetMinutes(iso), offset);
    });
  }
});

Deno.test("isoAt: метка в зоне момента старта", async (t) => {
  const atMs = Date.parse("2026-08-14T16:50:33.987Z");

  await t.step("московская зона", () => {
    assertEquals(isoAt(atMs, 180), "2026-08-14T19:50:33.000+03:00");
  });

  await t.step("UTC", () => {
    assertEquals(isoAt(atMs, 0), "2026-08-14T16:50:33.000+00:00");
  });

  await t.step("отрицательная зона с получасом", () => {
    assertEquals(isoAt(atMs, -330), "2026-08-14T11:20:33.000-05:30");
  });

  await t.step("миллисекунды всегда .000", () => {
    assertEquals(isoAt(atMs, 180).endsWith(".000+03:00"), true);
  });
});

Deno.test("floorToMinute и shiftMinutes: границы записи", async (t) => {
  const atMs = Date.parse("2026-08-14T19:50:33.987+03:00");

  await t.step("усечение вниз до минуты", () => {
    assertEquals(
      floorToMinute(atMs),
      Date.parse("2026-08-14T19:50:00.000+03:00"),
    );
  });

  await t.step("уже целая минута не меняется", () => {
    const whole = Date.parse("2026-08-14T19:50:00.000+03:00");
    assertEquals(floorToMinute(whole), whole);
  });

  await t.step("сдвиг вперёд и назад", () => {
    assertEquals(shiftMinutes(atMs, 75) - atMs, 75 * 60_000);
    assertEquals(shiftMinutes(atMs, -75) - atMs, -75 * 60_000);
  });
});

Deno.test("elapsedMinutes: округление вверх, как у сервера", async (t) => {
  const from = Date.parse("2026-08-14T19:50:00.000+03:00");

  await t.step("неполная минута — единица", () => {
    assertEquals(elapsedMinutes(from, from + 1_000), 1);
  });

  await t.step("ровная минута — она и есть", () => {
    assertEquals(elapsedMinutes(from, from + 60_000), 1);
  });

  await t.step("секунда сверх минуты — две", () => {
    assertEquals(elapsedMinutes(from, from + 61_000), 2);
  });

  await t.step("тот же момент — ноль", () => {
    assertEquals(elapsedMinutes(from, from), 0);
  });

  await t.step("старт в будущем — ноль, а не отрицательное", () => {
    assertEquals(elapsedMinutes(from, from - 90_000), 0);
  });
});
