/**
 * Проводка входа в локальный sw-front (`copy-client.md`, шаг 6):
 * форма операторов и цели конфликтов.
 *
 * Ключи сверены на живой схеме воркспейсов стенда 2026-08-28:
 * `users(email)` — уникальный индекс, `users(id)` и `wb_cabinets(sid)`
 * — первичные ключи, а у `workspaces_wb_cabinets` ключ **составной**.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { localEmail, seedStatements } from "./sw_front.ts";

const SQL = seedStatements(5175, [{ sid: "cab-1", name: "Магазин" }]);

Deno.test("проводка идемпотентна: у каждой вставки есть ON CONFLICT", () => {
  const inserts = SQL.split("\n").filter((line) =>
    line.startsWith("INSERT INTO")
  );
  assertEquals(inserts.length > 0, true);
  for (const insert of inserts) {
    // Повторный прогон — обычный случай: второй пользователь с тем же
    // адресом сделал бы вход неоднозначным.
    assertStringIncludes(insert, "ON CONFLICT");
  }
});

Deno.test("цели конфликтов — те, что есть в схеме", async (t) => {
  await t.step("users по адресу", () => {
    assertStringIncludes(SQL, "ON CONFLICT (email) DO UPDATE");
    assertStringIncludes(SQL, localEmail(5175));
  });

  await t.step("workspaces и wb_cabinets по своим ключам", () => {
    assertStringIncludes(SQL, "ON CONFLICT (id) DO UPDATE");
    assertStringIncludes(SQL, "ON CONFLICT (sid) DO UPDATE");
  });

  await t.step("связка кабинета — без цели: ключ составной", () => {
    const link = SQL.split("\n").find((line) =>
      line.includes("workspaces_wb_cabinets")
    )!;
    // `ON CONFLICT (sid)` отбился бы «нет уникального индекса под
    // указанные колонки»: первичный ключ здесь `(workspace_id, sid)`.
    assertStringIncludes(link, "ON CONFLICT DO NOTHING");
    assertEquals(link.includes("ON CONFLICT (sid)"), false);
  });
});

Deno.test("кабинета нет — вход всё равно заводится", () => {
  const bare = seedStatements(5175, []);
  assertStringIncludes(bare, "INSERT INTO public.users");
  assertStringIncludes(bare, "INSERT INTO public.workspaces");
  // Кабинетов нет — и связок с подписками тоже: вход существует сам по
  // себе, а витрина покажет пустой список.
  assertEquals(bare.includes("wb_cabinets"), false);
});
