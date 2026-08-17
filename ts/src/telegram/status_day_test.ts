import { assertEquals } from "@std/assert";
import { mskDayWindow } from "./status_day.ts";

Deno.test("окно московского дня: включительно по обеим границам", () => {
  // 2026-08-17 10:00 МСК — середина дня голденов.
  const window = mskDayWindow(Date.parse("2026-08-17T07:00:00.000Z"));
  assertEquals(window.day, "2026-08-17");
  assertEquals(window.fromIso, "2026-08-16T21:00:00Z");
  assertEquals(window.toIso, "2026-08-17T20:59:59Z");
  assertEquals(window.fromSec, Date.parse("2026-08-16T21:00:00.000Z") / 1000);
  assertEquals(window.toSec, window.fromSec + 24 * 60 * 60 - 1);
});

Deno.test("день берётся по МСК, а не по зоне машины", async (t) => {
  await t.step("22:30 UTC — уже завтра по МСК", () => {
    assertEquals(
      mskDayWindow(Date.parse("2026-08-17T22:30:00.000Z")).day,
      "2026-08-18",
    );
  });
  await t.step("20:59:59 UTC — ещё сегодня по МСК", () => {
    assertEquals(
      mskDayWindow(Date.parse("2026-08-17T20:59:59.000Z")).day,
      "2026-08-17",
    );
  });
});

Deno.test("границы окна принадлежат своему дню", () => {
  const window = mskDayWindow(Date.parse("2026-08-17T07:00:00.000Z"));
  for (const at of [window.fromSec, window.toSec]) {
    assertEquals(mskDayWindow(at * 1000).day, window.day);
  }
});
