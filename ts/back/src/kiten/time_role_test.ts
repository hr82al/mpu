/**
 * Выбор роли записи времени (`docs/specs/kiten-time.md`, «CLI-контракт» и
 * «Инварианты»). Выбор внутри справочника чист и проверяется без сети;
 * сети касается только `resolveRoleId`, и под проверкой у него состав
 * вызовов: инвариант спеки — на числовом значении запроса нет. Что
 * справочник читается мутирующими подкомандами всегда (ради названия
 * роли для вывода), стережёт `cmd_time_test.ts` — там видно место
 * запроса.
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
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

function stand(): Stand {
  const fake = startFakeKaiten(() => Response.json(ROLES));
  return {
    access: { baseUrl: fake.baseUrl, apiKey: "proba-key" },
    seen: fake.seen,
    stop: fake.stop,
  };
}

function paths(seen: readonly CapturedRequest[]): readonly string[] {
  return seen.map((request) => request.pathname);
}

Deno.test("resolveRoleId: числовое значение — id без запроса", async () => {
  const { access, seen, stop } = stand();
  try {
    assertEquals(await resolveRoleId(access, "12058"), 12058);
    assertEquals(paths(seen), []);
  } finally {
    await stop();
  }
});

Deno.test("resolveRoleId: нечисловое — живой справочник", async (t) => {
  await t.step("точное название без учёта регистра", async () => {
    const { access, seen, stop } = stand();
    try {
      assertEquals(await resolveRoleId(access, "техподдержка"), 12058);
      assertEquals(paths(seen), ["/api/latest/user-roles"]);
    } finally {
      await stop();
    }
  });

  await t.step("точное совпадение старше подстроки", async () => {
    const { access, stop } = stand();
    try {
      assertEquals(await resolveRoleId(access, "Тестирование"), 12132);
    } finally {
      await stop();
    }
  });

  await t.step("подстрока, когда точного нет", async () => {
    const { access, stop } = stand();
    try {
      assertEquals(await resolveRoleId(access, "нагрузки"), 12200);
    } finally {
      await stop();
    }
  });

  await t.step("нет совпадений — ошибка ввода", async () => {
    const { access, stop } = stand();
    try {
      const err = await assertRejects(
        () => resolveRoleId(access, "инженер"),
        UsageError,
      );
      assertEquals(
        err.message,
        "role 'инженер' не найден — см. `mpu kiten roles`",
      );
    } finally {
      await stop();
    }
  });

  await t.step("несколько подстрочных — кандидаты списком", async () => {
    const { access, stop } = stand();
    try {
      const err = await assertRejects(
        () => resolveRoleId(access, "тест"),
        UsageError,
      );
      assertEquals(err.message, "role 'тест' неоднозначен (2 совпадений):");
      assertEquals(
        err.details,
        "12132 (Тестирование)\n12200 (Тестирование нагрузки)",
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("chooseRoleId: цепочка флаг → env → дефолт", async (t) => {
  await t.step("явный флаг старше настройки", () => {
    assertEquals(chooseRoleId(ROLES, "12132", "Техподдержка"), 12132);
  });

  await t.step("без флага берётся настройка", () => {
    assertEquals(chooseRoleId(ROLES, undefined, "Тестирование"), 12132);
  });

  await t.step("числовая настройка берётся как id", () => {
    assertEquals(chooseRoleId(ROLES, undefined, "777"), 777);
  });

  await t.step("нет ни флага, ни настройки — дефолт", () => {
    assertEquals(chooseRoleId(ROLES, undefined, undefined), DEFAULT_ROLE_ID);
  });

  await t.step("пустая настройка равнозначна её отсутствию", () => {
    assertEquals(chooseRoleId(ROLES, undefined, "  "), DEFAULT_ROLE_ID);
  });

  await t.step("нерезолвимая настройка падает, а не откатывается", () => {
    const err = assertThrows(
      () => chooseRoleId(ROLES, undefined, "инженер"),
      UsageError,
    );
    assertEquals(
      err.message,
      "KITEN_TIME_ROLE: role 'инженер' не найден — см. `mpu kiten roles`",
    );
  });
});

Deno.test("roleNameOf: название для вывода мутирующей подкоманды", async (t) => {
  await t.step("роль из справочника — её название", () => {
    assertEquals(roleNameOf(ROLES, 12058), "Техподдержка");
  });

  await t.step("роли нет в справочнике — null", () => {
    assertEquals(roleNameOf(ROLES, 777), null);
  });

  await t.step("роли у записи нет вовсе — null", () => {
    assertEquals(roleNameOf(ROLES, null), null);
  });

  await t.step("пустое название равнозначно его отсутствию", () => {
    assertEquals(roleNameOf([{ id: 12058, name: "" }], 12058), null);
  });
});
