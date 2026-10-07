/**
 * Выбор роли записи времени (`docs/specs/kiten-time.md`, «CLI-контракт» и
 * «Инварианты»). Выбор внутри справочника чист и проверяется без сети;
 * сети касается только `resolveRoleId`, и под проверкой у него состав
 * вызовов: инвариант спеки — на числовом значении запроса нет. Что
 * справочник читается мутирующими подкомандами всегда (ради названия
 * роли для вывода), стережёт `cmd_time_test.ts` — там видно место
 * запроса.
 */

import { describe, expect, it } from "vitest";
import { rejected, thrown } from "../testing/thrown.ts";
import { UsageError } from "../command/mod.ts";
import type { KaitenAccess } from "../kaiten/mod.ts";
import { type CapturedRequest, startFakeKaiten } from "../kaiten/testing.ts";
import {
  chooseRoleId,
  DEFAULT_ROLE_ID,
  resolveRoleId,
  roleNameOf,
} from "./time_role.ts";

const ROLES = [
  { id: 12058, name: "Техподдержка" },
  { id: 12132, name: "Тестирование" },
  { id: 12200, name: "Тестирование нагрузки" },
];

interface Stand {
  readonly access: KaitenAccess;
  readonly seen: readonly CapturedRequest[];
  readonly stop: () => Promise<void>;
}

async function stand(): Promise<Stand> {
  const fake = await startFakeKaiten(() => Response.json(ROLES));
  return {
    access: { baseUrl: fake.baseUrl, apiKey: "proba-key" },
    seen: fake.seen,
    stop: fake.stop,
  };
}

function paths(seen: readonly CapturedRequest[]): readonly string[] {
  return seen.map((request) => request.pathname);
}

it("resolveRoleId: числовое значение — id без запроса", async () => {
  const { access, seen, stop } = await stand();
  try {
    expect(await resolveRoleId(access, "12058")).toBe(12058);
    expect(paths(seen)).toStrictEqual([]);
  } finally {
    await stop();
  }
});

describe("resolveRoleId: нечисловое — живой справочник", () => {
  it("точное название без учёта регистра", async () => {
    const { access, seen, stop } = await stand();
    try {
      expect(await resolveRoleId(access, "техподдержка")).toBe(12058);
      expect(paths(seen)).toStrictEqual(["/api/latest/user-roles"]);
    } finally {
      await stop();
    }
  });

  it("точное совпадение старше подстроки", async () => {
    const { access, stop } = await stand();
    try {
      expect(await resolveRoleId(access, "Тестирование")).toBe(12132);
    } finally {
      await stop();
    }
  });

  it("подстрока, когда точного нет", async () => {
    const { access, stop } = await stand();
    try {
      expect(await resolveRoleId(access, "нагрузки")).toBe(12200);
    } finally {
      await stop();
    }
  });

  it("нет совпадений — ошибка ввода", async () => {
    const { access, stop } = await stand();
    try {
      const err = await rejected(
        () => resolveRoleId(access, "инженер"),
        UsageError,
      );
      expect(err.message).toBe(
        "role 'инженер' не найден — см. `mpu kiten roles`",
      );
    } finally {
      await stop();
    }
  });

  it("несколько подстрочных — кандидаты списком", async () => {
    const { access, stop } = await stand();
    try {
      const err = await rejected(
        () => resolveRoleId(access, "тест"),
        UsageError,
      );
      expect(err.message).toBe("role 'тест' неоднозначен (2 совпадений):");
      expect(err.details).toBe(
        "12132 (Тестирование)\n12200 (Тестирование нагрузки)",
      );
    } finally {
      await stop();
    }
  });
});

describe("chooseRoleId: цепочка флаг → env → дефолт", () => {
  it("явный флаг старше настройки", () => {
    expect(chooseRoleId(ROLES, "12132", "Техподдержка")).toBe(12132);
  });

  it("без флага берётся настройка", () => {
    expect(chooseRoleId(ROLES, undefined, "Тестирование")).toBe(12132);
  });

  it("числовая настройка берётся как id", () => {
    expect(chooseRoleId(ROLES, undefined, "777")).toBe(777);
  });

  it("нет ни флага, ни настройки — дефолт", () => {
    expect(chooseRoleId(ROLES, undefined, undefined)).toStrictEqual(
      DEFAULT_ROLE_ID,
    );
  });

  it("пустая настройка равнозначна её отсутствию", () => {
    expect(chooseRoleId(ROLES, undefined, "  ")).toStrictEqual(DEFAULT_ROLE_ID);
  });

  it("нерезолвимая настройка падает, а не откатывается", () => {
    const err = thrown(() => {
      chooseRoleId(ROLES, undefined, "инженер");
    }, UsageError);
    expect(err.message).toBe(
      "KITEN_TIME_ROLE: role 'инженер' не найден — см. `mpu kiten roles`",
    );
  });
});

describe("roleNameOf: название для вывода мутирующей подкоманды", () => {
  it("роль из справочника — её название", () => {
    expect(roleNameOf(ROLES, 12058)).toBe("Техподдержка");
  });

  it("роли нет в справочнике — null", () => {
    expect(roleNameOf(ROLES, 777)).toStrictEqual(null);
  });

  it("роли у записи нет вовсе — null", () => {
    expect(roleNameOf(ROLES, null)).toStrictEqual(null);
  });

  it("пустое название равнозначно его отсутствию", () => {
    expect(roleNameOf([{ id: 12058, name: "" }], 12058)).toStrictEqual(null);
  });
});
