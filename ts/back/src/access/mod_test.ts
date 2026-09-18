import { assertEquals } from "@std/assert";
import { hasBearer, LOOPBACK_ORIGINS } from "./mod.ts";

Deno.test("Origin: петля, её имена и добавленный хост", async (t) => {
  const withFront = LOOPBACK_ORIGINS.with("mpu.localhost");
  const cases: readonly (readonly [string, boolean, boolean])[] = [
    ["http://127.0.0.1:7337", true, true],
    ["http://localhost", true, true],
    ["http://[::1]:8080", true, true],
    ["http://mpu.localhost:7338", false, true],
    ["http://evil.localhost", false, false],
    ["http://127.0.0.1.evil.com", false, false],
    ["не адрес", false, false],
  ];
  for (const [origin, loopback, front] of cases) {
    await t.step(origin, () => {
      assertEquals(LOOPBACK_ORIGINS.allows(origin), loopback);
      assertEquals(withFront.allows(origin), front);
    });
  }
});

Deno.test("токен — только точный заголовок Bearer", () => {
  const request = (value?: string) =>
    new Request("http://127.0.0.1/", {
      headers: value === undefined ? {} : { Authorization: value },
    });
  assertEquals(hasBearer(request("Bearer t"), "t"), true);
  assertEquals(hasBearer(request("Bearer tt"), "t"), false);
  assertEquals(hasBearer(request("bearer t"), "t"), false);
  assertEquals(hasBearer(request(), "t"), false);
});
