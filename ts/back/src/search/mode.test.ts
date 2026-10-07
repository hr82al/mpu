/**
 * Выбор ветки `mpu search` (`docs/specs/search.md`, «CLI-контракт»):
 * `modeOf` и `effectiveScope` — чистые функции, кэш и сеть не нужны.
 */

import { describe, expect, it } from "vitest";
import { effectiveScope, isEmail, type ModeInputs, modeOf } from "./mode.ts";

function inputs(overrides: Partial<ModeInputs> = {}): ModeInputs {
  return {
    value: "10",
    scope: "auto",
    reasonGiven: false,
    refreshCache: false,
    ...overrides,
  };
}

describe("modeOf: таблица случаев спеки", () => {
  const cases: readonly (readonly [string, Partial<ModeInputs>, string])[] = [
    ["число, все флаги умолчаний — локальный режим", {}, "local"],
    [
      "сервер-адрес, все флаги умолчаний — локальный режим",
      { value: "10.9.9.9" },
      "local",
    ],
    ["email, scope auto — email-ветка", { value: "u@example.com" }, "email"],
    [
      "email с --scope access — не email-ветка, а 10X-резолв селектора",
      { value: "u@example.com", scope: "access" },
      "x10-selector",
    ],
    [
      "email с --scope user — остаётся email-веткой",
      { value: "u@example.com", scope: "user" },
      "email",
    ],
    [
      "--reason задан — 10X-резолв селектора",
      { reasonGiven: true },
      "x10-selector",
    ],
    [
      "--refresh-cache задан — 10X-резолв селектора",
      { refreshCache: true },
      "x10-selector",
    ],
    [
      "--scope user (не email) — 10X-резолв селектора",
      { scope: "user" },
      "x10-selector",
    ],
    [
      "--scope access (не email) — 10X-резолв селектора",
      { scope: "access" },
      "x10-selector",
    ],
  ];
  for (const [name, overrides, expected] of cases) {
    it(name, () => {
      expect(modeOf(inputs(overrides))).toStrictEqual(expected);
    });
  }
});

it("isEmail: маска предиката резолва", () => {
  expect(isEmail("u@example.com")).toBe(true);
  expect(isEmail("u@example")).toBe(false);
  expect(isEmail("u example.com")).toBe(false);
  expect(isEmail("10")).toBe(false);
});

describe("effectiveScope: auto по форме селектора, явный scope не переопределяется", () => {
  const cases:
    readonly (readonly [string, string, "auto" | "user" | "access", string])[] =
      [
        ["целое, auto — access", "10", "auto", "access"],
        [
          "полный uuid, auto — access",
          "00000000-0000-4000-8000-000000000001",
          "auto",
          "access",
        ],
        [
          "полный uuid в верхнем регистре, auto — access",
          "00000000-0000-4000-8000-000000000001".toUpperCase(),
          "auto",
          "access",
        ],
        [
          "строка не uuid и не целое, auto — user",
          "u@example.com",
          "auto",
          "user",
        ],
        ["заголовок, auto — user", "Отчёт", "auto", "user"],
        ["целое, явный user — не переопределяется", "10", "user", "user"],
        ["целое, явный access — не переопределяется", "10", "access", "access"],
        [
          "не-целое, явный access — не переопределяется",
          "текст",
          "access",
          "access",
        ],
      ];
  for (const [name, value, scope, expected] of cases) {
    it(name, () => {
      expect(effectiveScope(value, scope)).toStrictEqual(expected);
    });
  }
});
