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

import { describe, expect, it } from "vitest";
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

const STATEMENTS = seedStatements(5175, [
  {
    sid: "cab-1",
    name: "Магазин",
    trade_mark: "ТМ",
  },
]);
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
    item.sql.startsWith("INSERT INTO public.workspaces_wb_cabinets"),
  )!;

it("проводка идемпотентна: у каждой вставки есть ON CONFLICT", () => {
  expect(STATEMENTS.length > 0).toBe(true);
  // Снятие чужой привязки — не вставка: у него своя идемпотентность —
  // повторный прогон просто не находит, что снимать.
  for (const statement of STATEMENTS.filter((item) =>
    item.sql.startsWith("INSERT"),
  )) {
    // Повторный прогон — обычный случай: второй пользователь с тем же
    // адресом сделал бы вход неоднозначным.
    expect(statement.sql).toContain("ON CONFLICT");
  }
});

describe("состав колонок users и workspaces отвечает замеру схемы", () => {
  // Замер покрывает только эти две таблицы; колонки трёх операторов
  // кабинета не мерялись — до них исполнение ни разу не доходило.
  it("users называет name: она NOT NULL", () => {
    // Ровно на ней шаг и падал: `null value in column "name" of
    // relation "users" violates not-null constraint`.
    expect(sqlOf("users")).toContain(
      "INSERT INTO public.users (email, password, name, is_email_verified",
    );
    expect(of("users")[0].params?.[2]).toBe("client_5175");
  });

  it("отметки времени проставляются явно, а не через умолчание", () => {
    // Замер снял обязательность, но не умолчания, а PostgreSQL называет
    // нарушение NOT NULL по порядку колонок: отказ на `name` (4-я)
    // ничего не говорит про `created_at` (5-ю) и `updated_at` (6-ю).
    for (const label of ["users", "workspaces"]) {
      expect(sqlOf(label)).toContain("created_at");
      expect(sqlOf(label)).toContain("updated_at = NOW()");
    }
  });

  it("id воркспейса приведён к типу явно", () => {
    // Единственный оператор формы `INSERT … SELECT`: там тип параметра
    // выводится не из целевой колонки, и нетипизированный `$1` мог бы
    // разрешиться в text.
    expect(sqlOf("workspaces")).toContain("SELECT $1::int");
  });

  it("workspaces перечисляет ровно то, что в схеме есть", () => {
    const sql = sqlOf("workspaces");
    // `is_active` в таблице нет — на ней и падает рабочая версия.
    // `marketplace` есть и допускает NULL: полный замер схемы поправил
    // первое, неполное перечисление колонок.
    expect(sql.includes("is_active"), sql).toBe(false);
    expect(sql).toContain("'Wildberries'");
    expect(sql).toContain(
      "INSERT INTO public.workspaces (id, owner_id, name, slug, ",
    );
  });
});

describe("значения уходят параметрами, а не текстом", () => {
  it("почта и хэш — в параметрах, не в тексте", () => {
    const users = of("users")[0];
    const hash = String(users.params?.[1]);
    expect(users.sql.includes(localEmail(5175))).toBe(false);
    expect(users.sql.includes(hash)).toBe(false);
    expect(users.params?.[0]).toStrictEqual(localEmail(5175));
    expect(hash.startsWith("$2b$10$")).toBe(true);
  });

  it("мест $n ровно столько, сколько значений", () => {
    // Общий инвариант, а не проверка каждого оператора глазами: лишнее
    // место даёт «bind message supplies N parameters», недостающее —
    // молча уехавшее не то значение.
    for (const statement of STATEMENTS) {
      const places = [...statement.sql.matchAll(/\$(\d+)/g)].map((match) =>
        Number(match[1]),
      );
      expect(Math.max(0, ...places), statement.label).toStrictEqual(
        statement.params?.length ?? 0,
      );
    }
  });

  it("имя кабинета с кавычкой не меняет текст запроса", () => {
    // Название приходит из чужой базы; прежде защитой было удвоение
    // кавычки, то есть настройка сервера.
    const [statement] = seedStatements(5175, [
      { sid: "cab-1", name: "О'Брайен", trade_mark: "ТМ" },
    ]).filter((item) => item.label === "wb_cabinets");
    expect(statement.sql.includes("О'Брайен")).toBe(false);
    expect(statement.params?.[1]).toBe("О'Брайен");
  });

  it("sid уходит параметром во всех трёх операторах кабинета", () => {
    for (const label of [
      "wb_cabinets",
      "workspaces_wb_cabinets",
      "subscriptions",
    ]) {
      const [statement] = of(label);
      expect(statement.sql.includes("cab-1"), label).toBe(false);
      expect(statement.params?.includes("cab-1"), label).toBe(true);
    }
  });
});

describe("цели конфликтов — те, что есть в схеме", () => {
  it("users по адресу", () => {
    expect(sqlOf("users")).toContain("ON CONFLICT (email) DO UPDATE");
  });

  it("workspaces и wb_cabinets по своим ключам", () => {
    expect(sqlOf("workspaces")).toContain("ON CONFLICT (id) DO UPDATE");
    expect(sqlOf("wb_cabinets")).toContain("ON CONFLICT (sid) DO UPDATE");
  });

  it("связка кабинета — без цели: ключ составной", () => {
    const link = linkInsert().sql;
    // `ON CONFLICT (sid)` отбился бы «нет уникального индекса под
    // указанные колонки»: первичный ключ здесь `(workspace_id, sid)`.
    expect(link).toContain("ON CONFLICT DO NOTHING");
    expect(link.includes("ON CONFLICT (sid)")).toBe(false);
  });
});

it("кабинета нет — вход всё равно заводится", () => {
  const bare = seedStatements(5175, []);
  expect(bare.map((statement) => statement.label)).toStrictEqual([
    "users",
    "workspaces",
  ]);
  // Кабинетов нет — и связок с подписками тоже: вход существует сам по
  // себе, а витрина покажет пустой список.
  expect(bare.some((item) => item.sql.includes("wb_cabinets"))).toBe(false);
});

describe("форма по снятой схеме воркспейсов", () => {
  it("slug задан и при повторном прогоне не переписывается", () => {
    const sql = sqlOf("workspaces");
    // Колонка NOT NULL без умолчания и уникальна: без неё круг упёрся
    // бы в неё сразу после `name`. А в обновление она не входит —
    // чужой slug переписывать нельзя.
    expect(sql).toContain("name, slug, marketplace");
    expect(of("workspaces")[0].params?.[2]).toBe("client-5175");
    const update = sql.slice(sql.indexOf("DO UPDATE"));
    expect(update.includes("slug"), update).toBe(false);
  });

  it("updated_at проставляется во всех трёх таблицах", () => {
    // NOT NULL без умолчания у `users`, `workspaces` и `subscriptions`:
    // сервер её сам не подставит.
    for (const label of ["users", "workspaces", "subscriptions"]) {
      const sql = sqlOf(label);
      expect(sql).toContain("updated_at");
      expect(sql.slice(sql.indexOf("DO UPDATE"))).toContain(
        "updated_at = NOW()",
      );
    }
    // А у кабинета такой колонки нет вовсе.
    expect(sqlOf("wb_cabinets").includes("updated_at")).toBe(false);
  });

  it("подписка адресуется кабинетом, а не пространством", () => {
    // Ключ `sid`, он же внешний ключ на `wb_cabinets`; колонки
    // `workspace_id` в таблице нет.
    const sql = sqlOf("subscriptions");
    expect(sql.includes("workspace_id"), sql).toBe(false);
    expect(of("subscriptions")[0].params?.[0]).toBe("cab-1");
  });

  it("торговая марка обязательна и уходит значением", () => {
    expect(sqlOf("wb_cabinets")).toContain("(sid, name, trade_mark,");
    expect(of("wb_cabinets")[0].params?.[2]).toBe("ТМ");
    // Обязательная колонка и внешний ключ: при перестановке параметров
    // (их здесь пять) промолчали бы все прочие проверки.
    expect(of("wb_cabinets")[0].params?.[4]).toBe(5175);
  });

  it("значения перечислений приводятся к своему типу", () => {
    // Параметр приходит текстом, и без приведения сервер не выведет
    // тип сам.
    // Имя типа квалифицировано схемой: иначе правильность запроса
    // зависела бы от `search_path` роли.
    expect(sqlOf("wb_cabinets")).toContain('$4::public."WbTokenStatus"');
    expect(sqlOf("subscriptions")).toContain('$2::public."SubscriptionStatus"');
    expect(of("wb_cabinets")[0].params?.[3]).toBe("ACTIVE");
    expect(of("subscriptions")[0].params?.[1]).toBe("ACTIVE");
  });

  it("порядок задан внешними ключами", () => {
    // Кабинет ссылается на воркспейс, подписка — на кабинет: переставь
    // их, и вставка упрётся в внешний ключ.
    // Снятие чужой привязки идёт **до** вставки своей: сделай мы
    // наоборот — тот же оператор снёс бы только что вставленную строку,
    // если бы условие «чужой воркспейс» когда-нибудь ослабло.
    // Метки двух операторов связки совпадают, поэтому порядок
    // сверяется по первому слову оператора — оно и различает снятие от
    // вставки.
    expect(
      STATEMENTS.map(
        (statement) => `${statement.sql.split(" ")[0]} ${statement.label}`,
      ),
    ).toStrictEqual([
      "INSERT users",
      "INSERT workspaces",
      "INSERT wb_cabinets",
      "DELETE workspaces_wb_cabinets",
      "INSERT workspaces_wb_cabinets",
      "INSERT subscriptions",
    ]);
  });
});

it("пустые имена кабинета заменяются на заголовок клиента", async () => {
  // Подстановка живёт в чтении, а не в сборке операторов: обе колонки
  // на приёмнике обязательны, а пустое имя у свежего кабинета — обычное
  // дело. Пустая строка прошла бы NOT NULL, но витрина показала бы
  // кабинет без заголовка.
  const outcome: SqlOutcome = {
    kind: "rows",
    columns: ["sid", "name", "trade_mark"],
    rows: [
      ["cab-1", "", null],
      ["cab-2", "  ", "ТМ"],
    ],
  };
  const cabinets = await cabinetsOf(reader(outcome), 5175);
  expect(cabinets).toStrictEqual([
    { sid: "cab-1", name: "client 5175", trade_mark: "client 5175" },
    // Имя подхватывает торговую марку: заголовок из неё осмысленнее
    // номера клиента.
    { sid: "cab-2", name: "ТМ", trade_mark: "ТМ" },
  ]);
});

describe("связка переезжает вместе с кабинетом", () => {
  const detach = STATEMENTS.filter((item) => item.sql.startsWith(DETACH_SQL));

  it("чужая привязка снимается по sid этого кабинета", () => {
    expect(detach.length).toBe(1);
    expect(detach[0].sql).toStrictEqual(
      "DELETE FROM public.workspaces_wb_cabinets " +
        "WHERE sid = $1 AND workspace_id <> $2",
    );
    // Скоуп — один sid: связки чужих кабинетов трогать нечем, даже если
    // они висят на том же воркспейсе.
    expect(detach[0].params).toStrictEqual(["cab-1", 5175]);
  });

  it("кабинетов нет — снимать нечего", () => {
    const bare = seedStatements(5175, []);
    expect(bare.some((item) => item.sql.startsWith(DETACH_SQL))).toBe(false);
  });

  it("на каждый кабинет своё снятие", () => {
    const two = seedStatements(5175, [
      { sid: "cab-1", name: "A", trade_mark: "A" },
      { sid: "cab-2", name: "B", trade_mark: "B" },
    ]).filter((item) => item.sql.startsWith(DETACH_SQL));
    expect(two.map((item) => item.params?.[0])).toStrictEqual([
      "cab-1",
      "cab-2",
    ]);
  });
});

describe("число снятых привязок берётся у сервера, а не угадывается", () => {
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
        statements.map(
          (statement) =>
            ({
              kind: "done",
              rowcount: statement.sql.startsWith(DETACH_SQL) ? detached : 1,
            }) as SqlOutcome,
        ),
      ),
    close: () => Promise.resolve(),
  });

  it("снятую строку видно по счётчику оператора", async () => {
    const outcome = await seedLogin(reader(cabinets), target(1), 5175);
    expect(outcome).toStrictEqual({ cabinets: 1, detached: 1 });
  });

  it("снимать было нечего — ноль, а не выдумка", async () => {
    // Повторный прогон подряд: чужой привязки уже нет, и сообщать не о
    // чем.
    const outcome = await seedLogin(reader(cabinets), target(0), 5175);
    expect(outcome).toStrictEqual({ cabinets: 1, detached: 0 });
  });
});
