/**
 * Маршрут по селектору и адрес подключения из env-файла
 * (`specs/sql-ro.md`, «CLI-контракт» и «Конфигурация»).
 */

import { describe, expect, it } from "vitest";
import { thrown } from "@mpu/testing/thrown";
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

describe("маршрут по селектору: первое совпадение побеждает", () => {
  const cases: readonly [string, string, ReturnType<typeof routeOf>][] = [
    [
      "dev:42",
      "dev с хвостом-числом даёт client_id",
      {
        kind: "dev",
        clientId: 42,
      },
    ],
    [
      "dev:foo",
      "dev с нечисловым хвостом — без client_id, не ошибка",
      {
        kind: "dev",
        clientId: null,
      },
    ],
    [
      "dev:",
      "пустой хвост — тот же dev без client_id",
      {
        kind: "dev",
        clientId: null,
      },
    ],
    [
      "dev:-1",
      "отрицательный хвост числом не считается",
      {
        kind: "dev",
        clientId: null,
      },
    ],
    [
      "  WorkSpaces ",
      "sw-алиас без учёта регистра и краевых пробелов",
      {
        kind: "sw",
      },
    ],
    ["swpg", "алиас из списка", { kind: "sw" }],
    ["sl-0", "сервер целиком — обычный маршрут", { kind: "normal" }],
    ["swimming", "не алиас, а обычный селектор", { kind: "normal" }],
    ["dev", "без двоеточия dev-селектором не становится", { kind: "normal" }],
  ];
  for (const [selector, title, expected] of cases) {
    it(`${selector}: ${title}`, () => {
      expect(routeOf(selector)).toStrictEqual(expected);
    });
  }
});

describe("адрес сервера стенда: ключи и умолчания", () => {
  const full: Readonly<Record<string, string>> = {
    pg_3: "10.0.0.3",
    PG_PORT: "6432",
    PG_DB_NAME: "wb2",
    PG_MY_USER_NAME: "личный",
    PG_MAIN_USER_NAME: "общий",
    PG_MAIN_USER_PASSWORD: "секрет",
  };
  it("личные креды приоритетнее общих по каждому ключу", () => {
    const target: PgTarget = serverTarget(env(full), 3);
    expect(target).toStrictEqual({
      host: "10.0.0.3",
      port: 6432,
      database: "wb2",
      username: "личный",
      password: "секрет",
    });
  });
  it("порт и БД по умолчанию", () => {
    const target = serverTarget(
      env({
        pg_0: "10.0.0.1",
        PG_MAIN_USER_NAME: "u",
        PG_MY_USER_PASSWORD: "p",
      }),
      0,
    );
    expect(target.port).toBe(5432);
    expect(target.database).toBe("wb");
    expect(target.username).toBe("u");
  });
  it("нет адреса сервера — ошибка ввода текстом слоя", () => {
    const err = thrown(() => {
      serverTarget(env({}), 7);
    }, UsageError);
    expect(err.message).toStrictEqual(
      "environment variable pg_7 is not set. " +
        "Add it to /tmp/.env or export in shell.",
    );
  });
  it("нет кредов — ошибка ввода про общий ключ", () => {
    const err = thrown(() => {
      serverTarget(env({ pg_1: "10.0.0.2" }), 1);
    }, UsageError);
    expect(
      err.message.startsWith("environment variable PG_MAIN_USER_NAME"),
      err.message,
    ).toBe(true);
  });
  it("пустое значение равнозначно отсутствию ключа", () => {
    expect(() =>
      serverTarget(env({ pg_1: "10.0.0.2", PG_MY_USER_NAME: "" }), 1),
    ).toThrow(UsageError);
    expect(() =>
      serverTarget(env({ pg_1: "10.0.0.2", PG_MY_USER_NAME: "" }), 1),
    ).toThrow("PG_MAIN_USER_NAME");
  });
  it("битый порт — ошибка ввода, а не молчаливое умолчание", () => {
    expect(() =>
      serverTarget(env({ ...full, PG_PORT: "не-число" }), 3),
    ).toThrow(UsageError);
    expect(() =>
      serverTarget(env({ ...full, PG_PORT: "не-число" }), 3),
    ).toThrow("PG_PORT: ожидался номер порта, задано 'не-число'");
  });
});

describe("адрес dev-стенда: свои ключи и свои умолчания", () => {
  const creds = { DEV_PG_USER: "u", DEV_PG_PASSWORD: "p" };
  it("порт 5434 и БД mp_sl_1_dev по умолчанию", () => {
    expect(devTarget(env({ DEV_PG_HOST: "10.1.1.1", ...creds }))).toStrictEqual(
      {
        host: "10.1.1.1",
        port: 5434,
        database: "mp_sl_1_dev",
        username: "u",
        password: "p",
      },
    );
  });
  it("ключи env-файла перекрывают умолчания", () => {
    const target = devTarget(
      env({
        DEV_PG_HOST: "10.1.1.1",
        DEV_PG_PORT: "5555",
        DEV_PG_DB: "dev2",
        ...creds,
      }),
    );
    expect([target.port, target.database]).toStrictEqual([5555, "dev2"]);
  });
  it("креды стенда dev не подставляются из общих", () => {
    expect(() =>
      devTarget(env({ DEV_PG_HOST: "10.1.1.1", PG_MAIN_USER_NAME: "общий" })),
    ).toThrow(UsageError);
    expect(() =>
      devTarget(env({ DEV_PG_HOST: "10.1.1.1", PG_MAIN_USER_NAME: "общий" })),
    ).toThrow("DEV_PG_USER");
  });
});
