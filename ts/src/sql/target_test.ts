/**
 * Маршрут по селектору и адрес подключения из env-файла
 * (`specs/sql-ro.md`, «CLI-контракт» и «Конфигурация»).
 */

import { assertEquals, assertThrows } from "@std/assert";
import { DomainError, UsageError } from "../command/mod.ts";
import { devTarget, type PgTarget, routeOf, serverTarget } from "./target.ts";

/** Env-файл фейком: только чтение, значения теста. */
function env(values: Readonly<Record<string, string>>) {
  return {
    get: (name: string) => values[name],
    require: (name: string) => {
      const value = values[name];
      if (value !== undefined && value !== "") return value;
      // Класс и текст — как у слоя (`platform/env-file.md`, «Ввод/вывод»):
      // команда обязана донести текст дословно, сменив только класс.
      throw new DomainError(
        `environment variable ${name} is not set. ` +
          "Add it to /tmp/.env or export in shell.",
      );
    },
  };
}

Deno.test("маршрут по селектору: первое совпадение побеждает", async (t) => {
  const cases: readonly [string, string, ReturnType<typeof routeOf>][] = [
    ["dev:42", "dev с хвостом-числом даёт client_id", {
      kind: "dev",
      clientId: 42,
    }],
    ["dev:foo", "dev с нечисловым хвостом — без client_id, не ошибка", {
      kind: "dev",
      clientId: null,
    }],
    ["dev:", "пустой хвост — тот же dev без client_id", {
      kind: "dev",
      clientId: null,
    }],
    ["dev:-1", "отрицательный хвост числом не считается", {
      kind: "dev",
      clientId: null,
    }],
    ["  WorkSpaces ", "sw-алиас без учёта регистра и краевых пробелов", {
      kind: "sw",
    }],
    ["swpg", "алиас из списка", { kind: "sw" }],
    ["sl-0", "сервер целиком — обычный маршрут", { kind: "normal" }],
    ["swimming", "не алиас, а обычный селектор", { kind: "normal" }],
    ["dev", "без двоеточия dev-селектором не становится", { kind: "normal" }],
  ];
  for (const [selector, title, expected] of cases) {
    await t.step(`${selector}: ${title}`, () => {
      assertEquals(routeOf(selector), expected);
    });
  }
});

Deno.test("адрес сервера стенда: ключи и умолчания", async (t) => {
  const full: Readonly<Record<string, string>> = {
    pg_3: "10.0.0.3",
    PG_PORT: "6432",
    PG_DB_NAME: "wb2",
    PG_MY_USER_NAME: "личный",
    PG_MAIN_USER_NAME: "общий",
    PG_MAIN_USER_PASSWORD: "секрет",
  };
  await t.step("личные креды приоритетнее общих по каждому ключу", () => {
    const target: PgTarget = serverTarget(env(full), 3);
    assertEquals(target, {
      host: "10.0.0.3",
      port: 6432,
      database: "wb2",
      username: "личный",
      password: "секрет",
    });
  });
  await t.step("порт и БД по умолчанию", () => {
    const target = serverTarget(
      env({
        pg_0: "10.0.0.1",
        PG_MAIN_USER_NAME: "u",
        PG_MY_USER_PASSWORD: "p",
      }),
      0,
    );
    assertEquals(target.port, 5432);
    assertEquals(target.database, "wb");
    assertEquals(target.username, "u");
  });
  await t.step("нет адреса сервера — ошибка ввода текстом слоя", () => {
    const err = assertThrows(
      () => serverTarget(env({}), 7),
      UsageError,
    );
    assertEquals(
      err.message,
      "environment variable pg_7 is not set. " +
        "Add it to /tmp/.env or export in shell.",
    );
  });
  await t.step("нет кредов — ошибка ввода про общий ключ", () => {
    const err = assertThrows(
      () => serverTarget(env({ pg_1: "10.0.0.2" }), 1),
      UsageError,
    );
    assertEquals(
      err.message.startsWith("environment variable PG_MAIN_USER_NAME"),
      true,
      err.message,
    );
  });
  await t.step("пустое значение равнозначно отсутствию ключа", () => {
    assertThrows(
      () => serverTarget(env({ pg_1: "10.0.0.2", PG_MY_USER_NAME: "" }), 1),
      UsageError,
      "PG_MAIN_USER_NAME",
    );
  });
  await t.step("битый порт — ошибка ввода, а не молчаливое умолчание", () => {
    assertThrows(
      () => serverTarget(env({ ...full, PG_PORT: "не-число" }), 3),
      UsageError,
      "PG_PORT: ожидался номер порта, задано 'не-число'",
    );
  });
});

Deno.test("адрес dev-стенда: свои ключи и свои умолчания", async (t) => {
  const creds = { DEV_PG_USER: "u", DEV_PG_PASSWORD: "p" };
  await t.step("порт 5434 и БД mp_sl_1_dev по умолчанию", () => {
    assertEquals(devTarget(env({ DEV_PG_HOST: "10.1.1.1", ...creds })), {
      host: "10.1.1.1",
      port: 5434,
      database: "mp_sl_1_dev",
      username: "u",
      password: "p",
    });
  });
  await t.step("ключи env-файла перекрывают умолчания", () => {
    const target = devTarget(env({
      DEV_PG_HOST: "10.1.1.1",
      DEV_PG_PORT: "5555",
      DEV_PG_DB: "dev2",
      ...creds,
    }));
    assertEquals([target.port, target.database], [5555, "dev2"]);
  });
  await t.step("креды стенда dev не подставляются из общих", () => {
    assertThrows(
      () =>
        devTarget(env({ DEV_PG_HOST: "10.1.1.1", PG_MAIN_USER_NAME: "общий" })),
      UsageError,
      "DEV_PG_USER",
    );
  });
});
