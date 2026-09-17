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
import type { SqlOutcome } from "../sql/render.ts";
import type { SqlSession } from "../sql/session.ts";
import {
  cabinetsOf,
  DETACH_SQL,
  localEmail,
  seedLogin,
  seedStatements,
} from "./sw_front.ts";

/** Сессия, отвечающая одним заданным набором строк. */
function reader(outcome: SqlOutcome): SqlSession {
  return {
    query: () => Promise.resolve(outcome),
    run: () => Promise.reject(new Error("run не ожидается")),
    runMany: () => Promise.reject(new Error("runMany не ожидается")),
    close: () => Promise.resolve(),
  };
}

const STATEMENTS = seedStatements(5175, [{
  sid: "cab-1",
  name: "Магазин",
  trade_mark: "ТМ",
}]);
const of = (label: string) =>
  STATEMENTS.filter((statement) => statement.label === label);
const sqlOf = (label: string) => of(label)[0].sql;

/**
 * Вставка связки: метка `workspaces_wb_cabinets` теперь у двух
 * операторов — снятия чужой привязки и вставки своей, — и по метке их
 * не различить. Она общая намеренно: метка идёт оператору в текст
 * отказа, и обе строки про одну таблицу.
 */
const linkInsert = () =>
  STATEMENTS.find((item) =>
    item.sql.startsWith("INSERT INTO public.workspaces_wb_cabinets")
  )!;

Deno.test("проводка идемпотентна: у каждой вставки есть ON CONFLICT", () => {
  assertEquals(STATEMENTS.length > 0, true);
  // Снятие чужой привязки — не вставка: у него своя идемпотентность —
  // повторный прогон просто не находит, что снимать.
  for (
    const statement of STATEMENTS.filter((item) =>
      item.sql.startsWith("INSERT")
    )
  ) {
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
    assertEquals(of("users")[0].params?.[2], "client_5175");
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

  await t.step("workspaces перечисляет ровно то, что в схеме есть", () => {
    const sql = sqlOf("workspaces");
    // `is_active` в таблице нет — на ней и падает рабочая версия.
    // `marketplace` есть и допускает NULL: полный замер схемы поправил
    // первое, неполное перечисление колонок.
    assertEquals(sql.includes("is_active"), false, sql);
    assertStringIncludes(sql, "'Wildberries'");
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
      { sid: "cab-1", name: "О'Брайен", trade_mark: "ТМ" },
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
    const link = linkInsert().sql;
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

Deno.test("форма по снятой схеме воркспейсов", async (t) => {
  await t.step("slug задан и при повторном прогоне не переписывается", () => {
    const sql = sqlOf("workspaces");
    // Колонка NOT NULL без умолчания и уникальна: без неё круг упёрся
    // бы в неё сразу после `name`. А в обновление она не входит —
    // чужой slug переписывать нельзя.
    assertStringIncludes(sql, "name, slug, marketplace");
    assertEquals(of("workspaces")[0].params?.[2], "client-5175");
    const update = sql.slice(sql.indexOf("DO UPDATE"));
    assertEquals(update.includes("slug"), false, update);
  });

  await t.step("updated_at проставляется во всех трёх таблицах", () => {
    // NOT NULL без умолчания у `users`, `workspaces` и `subscriptions`:
    // сервер её сам не подставит.
    for (const label of ["users", "workspaces", "subscriptions"]) {
      const sql = sqlOf(label);
      assertStringIncludes(sql, "updated_at");
      assertStringIncludes(
        sql.slice(sql.indexOf("DO UPDATE")),
        "updated_at = NOW()",
      );
    }
    // А у кабинета такой колонки нет вовсе.
    assertEquals(sqlOf("wb_cabinets").includes("updated_at"), false);
  });

  await t.step("подписка адресуется кабинетом, а не пространством", () => {
    // Ключ `sid`, он же внешний ключ на `wb_cabinets`; колонки
    // `workspace_id` в таблице нет.
    const sql = sqlOf("subscriptions");
    assertEquals(sql.includes("workspace_id"), false, sql);
    assertEquals(of("subscriptions")[0].params?.[0], "cab-1");
  });

  await t.step("торговая марка обязательна и уходит значением", () => {
    assertStringIncludes(sqlOf("wb_cabinets"), "(sid, name, trade_mark,");
    assertEquals(of("wb_cabinets")[0].params?.[2], "ТМ");
    // Обязательная колонка и внешний ключ: при перестановке параметров
    // (их здесь пять) промолчали бы все прочие проверки.
    assertEquals(of("wb_cabinets")[0].params?.[4], 5175);
  });

  await t.step("значения перечислений приводятся к своему типу", () => {
    // Параметр приходит текстом, и без приведения сервер не выведет
    // тип сам.
    // Имя типа квалифицировано схемой: иначе правильность запроса
    // зависела бы от `search_path` роли.
    assertStringIncludes(sqlOf("wb_cabinets"), '$4::public."WbTokenStatus"');
    assertStringIncludes(
      sqlOf("subscriptions"),
      '$2::public."SubscriptionStatus"',
    );
    assertEquals(of("wb_cabinets")[0].params?.[3], "ACTIVE");
    assertEquals(of("subscriptions")[0].params?.[1], "ACTIVE");
  });

  await t.step("порядок задан внешними ключами", () => {
    // Кабинет ссылается на воркспейс, подписка — на кабинет: переставь
    // их, и вставка упрётся в внешний ключ.
    // Снятие чужой привязки идёт **до** вставки своей: сделай мы
    // наоборот — тот же оператор снёс бы только что вставленную строку,
    // если бы условие «чужой воркспейс» когда-нибудь ослабло.
    // Метки двух операторов связки совпадают, поэтому порядок
    // сверяется по первому слову оператора — оно и различает снятие от
    // вставки.
    assertEquals(
      STATEMENTS.map((statement) =>
        `${statement.sql.split(" ")[0]} ${statement.label}`
      ),
      [
        "INSERT users",
        "INSERT workspaces",
        "INSERT wb_cabinets",
        "DELETE workspaces_wb_cabinets",
        "INSERT workspaces_wb_cabinets",
        "INSERT subscriptions",
      ],
    );
  });
});

Deno.test("пустые имена кабинета заменяются на заголовок клиента", async () => {
  // Подстановка живёт в чтении, а не в сборке операторов: обе колонки
  // на приёмнике обязательны, а пустое имя у свежего кабинета — обычное
  // дело. Пустая строка прошла бы NOT NULL, но витрина показала бы
  // кабинет без заголовка.
  const outcome: SqlOutcome = {
    kind: "rows",
    columns: ["sid", "name", "trade_mark"],
    rows: [["cab-1", "", null], ["cab-2", "  ", "ТМ"]],
  };
  const cabinets = await cabinetsOf(reader(outcome), 5175);
  assertEquals(cabinets, [
    { sid: "cab-1", name: "client 5175", trade_mark: "client 5175" },
    // Имя подхватывает торговую марку: заголовок из неё осмысленнее
    // номера клиента.
    { sid: "cab-2", name: "ТМ", trade_mark: "ТМ" },
  ]);
});

Deno.test("связка переезжает вместе с кабинетом", async (t) => {
  const detach = STATEMENTS.filter((item) => item.sql.startsWith(DETACH_SQL));

  await t.step("чужая привязка снимается по sid этого кабинета", () => {
    assertEquals(detach.length, 1);
    assertEquals(
      detach[0].sql,
      "DELETE FROM public.workspaces_wb_cabinets " +
        "WHERE sid = $1 AND workspace_id <> $2",
    );
    // Скоуп — один sid: связки чужих кабинетов трогать нечем, даже если
    // они висят на том же воркспейсе.
    assertEquals(detach[0].params, ["cab-1", 5175]);
  });

  await t.step("кабинетов нет — снимать нечего", () => {
    const bare = seedStatements(5175, []);
    assertEquals(bare.some((item) => item.sql.startsWith(DETACH_SQL)), false);
  });

  await t.step("на каждый кабинет своё снятие", () => {
    const two = seedStatements(5175, [
      { sid: "cab-1", name: "A", trade_mark: "A" },
      { sid: "cab-2", name: "B", trade_mark: "B" },
    ]).filter((item) => item.sql.startsWith(DETACH_SQL));
    assertEquals(two.map((item) => item.params?.[0]), ["cab-1", "cab-2"]);
  });
});

Deno.test("число снятых привязок берётся у сервера, а не угадывается", async (t) => {
  const cabinets: SqlOutcome = {
    kind: "rows",
    columns: ["sid", "name", "trade_mark"],
    rows: [["cab-1", "Магазин", "ТМ"]],
  };

  /** Приёмник, отвечающий на посев заданными счётчиками строк. */
  const target = (detached: number): SqlSession => ({
    query: () => Promise.reject(new Error("query не ожидается")),
    run: () => Promise.reject(new Error("run не ожидается")),
    runMany: (statements) =>
      Promise.resolve(
        statements.map((statement) => ({
          kind: "done",
          rowcount: statement.sql.startsWith(DETACH_SQL) ? detached : 1,
        } as SqlOutcome)),
      ),
    close: () => Promise.resolve(),
  });

  await t.step("снятую строку видно по счётчику оператора", async () => {
    const outcome = await seedLogin(reader(cabinets), target(1), 5175);
    assertEquals(outcome, { cabinets: 1, detached: 1 });
  });

  await t.step("снимать было нечего — ноль, а не выдумка", async () => {
    // Повторный прогон подряд: чужой привязки уже нет, и сообщать не о
    // чем.
    const outcome = await seedLogin(reader(cabinets), target(0), 5175);
    assertEquals(outcome, { cabinets: 1, detached: 0 });
  });
});
