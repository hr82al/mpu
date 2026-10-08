import { describe, expect, it } from "vitest";
import { hasBearer, LOOPBACK_ORIGINS } from "./access.ts";

describe("Origin: петля, её имена и добавленный хост", () => {
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
    it(origin, () => {
      expect(LOOPBACK_ORIGINS.allows(origin)).toStrictEqual(loopback);
      expect(withFront.allows(origin)).toStrictEqual(front);
    });
  }
});

it("токен — только точный заголовок Bearer", () => {
  const request = (value?: string) =>
    new Request("http://127.0.0.1/", {
      headers: value === undefined ? {} : { Authorization: value },
    });
  expect(hasBearer(request("Bearer t"), "t")).toBe(true);
  expect(hasBearer(request("Bearer tt"), "t")).toBe(false);
  expect(hasBearer(request("bearer t"), "t")).toBe(false);
  expect(hasBearer(request(), "t")).toBe(false);
});
