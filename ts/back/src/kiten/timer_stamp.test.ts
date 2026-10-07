/**
 * Метки времени таймера (`docs/specs/kiten-time.md`, «Побочные эффекты»;
 * `platform/kaiten-api-time.md`, вызов 7). Под проверкой две
 * неочевидности обмена: зона метки берётся у момента старта, а
 * миллисекунды в отправляемых метках всегда `.000`.
 */

import { describe, expect, it } from "vitest";
import {
  elapsedMinutes,
  floorToMinute,
  isoAt,
  shiftMinutes,
  zoneOffsetMinutes,
} from "./timer_stamp.ts";

describe("zoneOffsetMinutes: зона из хвоста метки", () => {
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
    it(`${iso || "(пусто)"} → ${offset}`, () => {
      expect(zoneOffsetMinutes(iso)).toStrictEqual(offset);
    });
  }
});

describe("isoAt: метка в зоне момента старта", () => {
  const atMs = Date.parse("2026-08-14T16:50:33.987Z");

  it("московская зона", () => {
    expect(isoAt(atMs, 180)).toBe("2026-08-14T19:50:33.000+03:00");
  });

  it("UTC", () => {
    expect(isoAt(atMs, 0)).toBe("2026-08-14T16:50:33.000+00:00");
  });

  it("отрицательная зона с получасом", () => {
    expect(isoAt(atMs, -330)).toBe("2026-08-14T11:20:33.000-05:30");
  });

  it("миллисекунды всегда .000", () => {
    expect(isoAt(atMs, 180).endsWith(".000+03:00")).toBe(true);
  });
});

describe("floorToMinute и shiftMinutes: границы записи", () => {
  const atMs = Date.parse("2026-08-14T19:50:33.987+03:00");

  it("усечение вниз до минуты", () => {
    expect(floorToMinute(atMs)).toStrictEqual(
      Date.parse("2026-08-14T19:50:00.000+03:00"),
    );
  });

  it("уже целая минута не меняется", () => {
    const whole = Date.parse("2026-08-14T19:50:00.000+03:00");
    expect(floorToMinute(whole)).toStrictEqual(whole);
  });

  it("сдвиг вперёд и назад", () => {
    expect(shiftMinutes(atMs, 75) - atMs).toStrictEqual(75 * 60_000);
    expect(shiftMinutes(atMs, -75) - atMs).toStrictEqual(-75 * 60_000);
  });
});

describe("elapsedMinutes: округление вверх, как у сервера", () => {
  const from = Date.parse("2026-08-14T19:50:00.000+03:00");

  it("неполная минута — единица", () => {
    expect(elapsedMinutes(from, from + 1_000)).toBe(1);
  });

  it("ровная минута — она и есть", () => {
    expect(elapsedMinutes(from, from + 60_000)).toBe(1);
  });

  it("секунда сверх минуты — две", () => {
    expect(elapsedMinutes(from, from + 61_000)).toBe(2);
  });

  it("тот же момент — ноль", () => {
    expect(elapsedMinutes(from, from)).toBe(0);
  });

  it("старт в будущем — ноль, а не отрицательное", () => {
    expect(elapsedMinutes(from, from - 90_000)).toBe(0);
  });
});
