/**
 * Строка реестра чтения — правило (`docs/specs/call.md`, «Конфигурация»):
 * `{}` — ровно один сегмент пути, метод и хост сравниваются точно,
 * строка не той формы — дефект модуля.
 */

import { expect, it } from "vitest";
import { thrown } from "../testing/thrown.ts";
import { ReadRule, READS } from "./reads.ts";

it("{} — ровно один сегмент пути", () => {
  const rule = ReadRule.parse(
    "GET api-performance.ozon.ru/api/client/statistics/{}",
  );
  const host = "api-performance.ozon.ru";
  expect(rule.matches("GET", host, "/api/client/statistics/42")).toBe(true);
  expect(rule.matches("GET", host, "/api/client/statistics")).toBe(false);
  expect(rule.matches("GET", host, "/api/client/statistics/4/2")).toBe(false);
  expect(rule.matches("POST", host, "/api/client/statistics/42")).toBe(false);
  expect(rule.matches("GET", "example.com", "/api/client/statistics/42")).toBe(
    false,
  );
});

it("строка не той формы — ошибка модуля", () => {
  for (
    const line of ["PUT api-seller.ozon.ru/v1/x", "GET /v1/x", "GET a.ru/x y"]
  ) {
    thrown(() => ReadRule.parse(line), Error, "не той формы");
  }
});

it("посев спеки разобран целиком", () => {
  expect(READS.length).toBe(31);
  expect(
    READS.some((rule) =>
      rule.matches("POST", "api-seller.ozon.ru", "/v1/seller/info")
    ),
  ).toBe(true);
});
