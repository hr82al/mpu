/**
 * Проводка входа в локальный sw-front (`copy-client.md`, шаг 6):
 * состав колонок, цели конфликтов и то, что значения уходят
 * параметрами.
 *
 * Схема воркспейсов сверена на стенде 2026-08-28 и записана в спеке: у
 * `users` семь NOT NULL-колонок (включая `name`), у `workspaces` нет ни
 * `is_active`, ни `marketplace`. Эталон здесь — схема, а не рабочая
 * версия: она этот шаг тоже не проходит.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { localEmail, seedStatements } from "./sw_front.ts";

const STATEMENTS = seedStatements(5175, [{ sid: "cab-1", name: "Магазин" }]);
const of = (label: string) =>
  STATEMENTS.filter((statement) => statement.label === label);
const sqlOf = (label: string) => of(label)[0].sql;

Deno.test("проводка идемпотентна: у каждой вставки есть ON CONFLICT", () => {
  assertEquals(STATEMENTS.length > 0, true);
  for (const statement of STATEMENTS) {
    // Повторный прогон — обычный случай: второй пользователь с тем же
    // адресом сделал бы вход неоднозначным.
    assertStringIncludes(statement.sql, "ON CONFLICT");
  }
});

Deno.test("состав колонок users и workspaces отвечает замеру схемы", async (t) => {
  // Замер покрывает только эти две таблицы; колонки трёх операторов
  // кабинета не мерялись — до них исполнение ни разу не доходило.
  await t.step("users называет name: она NOT NULL", () => {
    // Ровно на ней шаг и падал: `null value in column "name" of
    // relation "users" violates not-null constraint`.
    assertStringIncludes(
      sqlOf("users"),
      "INSERT INTO public.users (email, password, name, is_email_verified",
    );
  });

  await t.step(
    "отметки времени проставляются явно, а не через умолчание",
    () => {
      // Замер снял обязательность, но не умолчания, а PostgreSQL называет
      // нарушение NOT NULL по порядку колонок: отказ на `name` (4-я)
      // ничего не говорит про `created_at` (5-ю) и `updated_at` (6-ю).
      for (const label of ["users", "workspaces"]) {
        assertStringIncludes(sqlOf(label), "created_at");
        assertStringIncludes(sqlOf(label), "updated_at = NOW()");
      }
    },
  );

  await t.step("id воркспейса приведён к типу явно", () => {
    // Единственный оператор формы `INSERT … SELECT`: там тип параметра
    // выводится не из целевой колонки, и нетипизированный `$1` мог бы
    // разрешиться в text.
    assertStringIncludes(sqlOf("workspaces"), "SELECT $1::int");
  });

  await t.step("workspaces не упоминает того, чего в схеме нет", () => {
    const sql = sqlOf("workspaces");
    // Обе колонки прежде перечислялись, и обеих в схеме нет: на
    // `is_active` падает рабочая версия.
    assertEquals(sql.includes("is_active"), false, sql);
    assertEquals(sql.includes("marketplace"), false, sql);
    assertStringIncludes(
      sql,
      "INSERT INTO public.workspaces (id, owner_id, name, slug, ",
    );
  });
});

Deno.test("значения уходят параметрами, а не текстом", async (t) => {
  await t.step("почта и хэш — в параметрах, не в тексте", () => {
    const users = of("users")[0];
    const hash = String(users.params?.[1]);
    assertEquals(users.sql.includes(localEmail(5175)), false);
    assertEquals(users.sql.includes(hash), false);
    assertEquals(users.params?.[0], localEmail(5175));
    assertEquals(hash.startsWith("$2b$10$"), true);
  });

  await t.step("мест $n ровно столько, сколько значений", () => {
    // Общий инвариант, а не проверка каждого оператора глазами: лишнее
    // место даёт «bind message supplies N parameters», недостающее —
    // молча уехавшее не то значение.
    for (const statement of STATEMENTS) {
      const places = [...statement.sql.matchAll(/\$(\d+)/g)]
        .map((match) => Number(match[1]));
      assertEquals(
        Math.max(0, ...places),
        statement.params?.length ?? 0,
        statement.label,
      );
    }
  });

  await t.step("имя кабинета с кавычкой не меняет текст запроса", () => {
    // Название приходит из чужой базы; прежде защитой было удвоение
    // кавычки, то есть настройка сервера.
    const [statement] = seedStatements(5175, [
      { sid: "cab-1", name: "О'Брайен" },
    ]).filter((item) => item.label === "wb_cabinets");
    assertEquals(statement.sql.includes("О'Брайен"), false);
    assertEquals(statement.params?.[1], "О'Брайен");
  });

  await t.step("sid уходит параметром во всех трёх операторах кабинета", () => {
    for (
      const label of ["wb_cabinets", "workspaces_wb_cabinets", "subscriptions"]
    ) {
      const [statement] = of(label);
      assertEquals(statement.sql.includes("cab-1"), false, label);
      assertEquals(statement.params?.includes("cab-1"), true, label);
    }
  });
});

Deno.test("цели конфликтов — те, что есть в схеме", async (t) => {
  await t.step("users по адресу", () => {
    assertStringIncludes(sqlOf("users"), "ON CONFLICT (email) DO UPDATE");
  });

  await t.step("workspaces и wb_cabinets по своим ключам", () => {
    assertStringIncludes(sqlOf("workspaces"), "ON CONFLICT (id) DO UPDATE");
    assertStringIncludes(sqlOf("wb_cabinets"), "ON CONFLICT (sid) DO UPDATE");
  });

  await t.step("связка кабинета — без цели: ключ составной", () => {
    const link = sqlOf("workspaces_wb_cabinets");
    // `ON CONFLICT (sid)` отбился бы «нет уникального индекса под
    // указанные колонки»: первичный ключ здесь `(workspace_id, sid)`.
    assertStringIncludes(link, "ON CONFLICT DO NOTHING");
    assertEquals(link.includes("ON CONFLICT (sid)"), false);
  });
});

Deno.test("кабинета нет — вход всё равно заводится", () => {
  const bare = seedStatements(5175, []);
  assertEquals(bare.map((statement) => statement.label), [
    "users",
    "workspaces",
  ]);
  // Кабинетов нет — и связок с подписками тоже: вход существует сам по
  // себе, а витрина покажет пустой список.
  assertEquals(bare.some((item) => item.sql.includes("wb_cabinets")), false);
});
