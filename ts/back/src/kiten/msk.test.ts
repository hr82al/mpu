/**
 * Московская зона (`docs/specs/kiten-time.md`, «Инварианты»). Случаи
 * подобраны вокруг полуночи: именно там зона машины и московская дают
 * разные ответы, и именно там расходятся день финиша `stop` и день,
 * который проставит сервер.
 */

import { describe, expect, it } from "vitest";
import { mskClock, mskDay } from "./msk.ts";

describe("mskDay: день по МСК, не по зоне машины", () => {
  const cases: readonly [string, string][] = [
    // 23:30 UTC 14-го — в Москве уже 15-е.
    ["2026-08-14T23:30:00Z", "2026-08-15"],
    // 20:59 UTC 14-го — в Москве ещё 14-е.
    ["2026-08-14T20:59:59Z", "2026-08-14"],
    ["2026-08-15T00:00:00Z", "2026-08-15"],
  ];
  for (const [iso, day] of cases) {
    it(`${iso} → ${day}`, () => {
      expect(mskDay(Date.parse(iso))).toStrictEqual(day);
    });
  }
});

describe("mskClock: часы и минуты по МСК", () => {
  const cases: readonly [string, string][] = [
    ["2026-08-14T16:50:33Z", "19:50"],
    // Полночь по МСК — предыдущий день по UTC.
    ["2026-08-14T21:00:00Z", "00:00"],
    // Смещение считается от момента, а не от текста метки.
    ["2026-08-14T19:50:00+03:00", "19:50"],
  ];
  for (const [iso, clock] of cases) {
    it(`${iso} → ${clock}`, () => {
      expect(mskClock(Date.parse(iso))).toStrictEqual(clock);
    });
  }
});
