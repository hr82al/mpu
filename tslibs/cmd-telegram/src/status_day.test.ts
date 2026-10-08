import { describe, expect, it } from "vitest";
import { mskDayWindow } from "./status_day.ts";

it("окно московского дня: включительно по обеим границам", () => {
  // 2026-08-17 10:00 МСК — середина дня голденов.
  const window = mskDayWindow(Date.parse("2026-08-17T07:00:00.000Z"));
  expect(window.day).toBe("2026-08-17");
  expect(window.fromIso).toBe("2026-08-16T21:00:00Z");
  expect(window.toIso).toBe("2026-08-17T20:59:59Z");
  expect(window.fromSec).toStrictEqual(
    Date.parse("2026-08-16T21:00:00.000Z") / 1000,
  );
  expect(window.toSec).toStrictEqual(window.fromSec + 24 * 60 * 60 - 1);
});

describe("день берётся по МСК, а не по зоне машины", () => {
  it("22:30 UTC — уже завтра по МСК", () => {
    expect(mskDayWindow(Date.parse("2026-08-17T22:30:00.000Z")).day).toBe(
      "2026-08-18",
    );
  });
  it("20:59:59 UTC — ещё сегодня по МСК", () => {
    expect(mskDayWindow(Date.parse("2026-08-17T20:59:59.000Z")).day).toBe(
      "2026-08-17",
    );
  });
});

it("границы окна принадлежат своему дню", () => {
  const window = mskDayWindow(Date.parse("2026-08-17T07:00:00.000Z"));
  for (const at of [window.fromSec, window.toSec]) {
    expect(mskDayWindow(at * 1000).day).toStrictEqual(window.day);
  }
});
