/**
 * Строка реестра чтения — правило (`docs/specs/call.md`, «Конфигурация»):
 * `{}` — ровно один сегмент пути, метод и хост сравниваются точно,
 * строка не той формы — дефект модуля.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { ReadRule, READS } from "./reads.ts";

Deno.test("{} — ровно один сегмент пути", () => {
  const rule = ReadRule.parse(
    "GET api-performance.ozon.ru/api/client/statistics/{}",
  );
  const host = "api-performance.ozon.ru";
  assertEquals(rule.matches("GET", host, "/api/client/statistics/42"), true);
  assertEquals(rule.matches("GET", host, "/api/client/statistics"), false);
  assertEquals(rule.matches("GET", host, "/api/client/statistics/4/2"), false);
  assertEquals(rule.matches("POST", host, "/api/client/statistics/42"), false);
  assertEquals(
    rule.matches("GET", "example.com", "/api/client/statistics/42"),
    false,
  );
});

Deno.test("строка не той формы — ошибка модуля", () => {
  for (
    const line of ["PUT api-seller.ozon.ru/v1/x", "GET /v1/x", "GET a.ru/x y"]
  ) {
    assertThrows(() => ReadRule.parse(line), Error, "не той формы");
  }
});

Deno.test("посев спеки разобран целиком", () => {
  assertEquals(READS.length, 31);
  assertEquals(
    READS.some((rule) =>
      rule.matches("POST", "api-seller.ozon.ru", "/v1/seller/info")
    ),
    true,
  );
});
