/**
 * Резолв базового URL и кред sl-back (`platform/slback-http.md`):
 * четыре правила адреса по порядку и перечисление недостающих ключей.
 */

import { expect, it } from "vitest";
import { thrown } from "../testing/thrown.ts";
import { DomainError, type EnvFile } from "../command/mod.ts";
import { slbackBaseUrl, slbackCredentials } from "./mod.ts";

function envOf(values: Readonly<Record<string, string>>): EnvFile {
  return {
    get: (name) => values[name],
    require: () => {
      throw new Error("require не ожидается");
    },
    set: () => Promise.reject(new Error("set не ожидается")),
    values: () => ({ ...values }),
  };
}

it("BASE_API_URL как полный URL побеждает хост", () => {
  expect(
    slbackBaseUrl(
      envOf({
        BASE_API_URL: "https://api.example.test/v2/",
        NEXT_PUBLIC_SERVER_URL: "https://другой.test",
      }),
    ),
  ).toBe("https://api.example.test/v2");
});

it("правило 2: у префикса срезаются ведущие слэши, у хоста — хвостовые", () => {
  expect(
    slbackBaseUrl(
      envOf({
        BASE_API_URL: "/api/",
        NEXT_PUBLIC_SERVER_URL: "https://sl.example.test//",
      }),
    ),
  ).toBe("https://sl.example.test/api/");
});

it("хвостовой слэш префикса остаётся — и даёт `//` перед путём", () => {
  // Не украшательство, а буква спеки: адрес обязан совпадать с адресом
  // прежней реализации, иначе сверка сравнивала бы разные запросы.
  const base = slbackBaseUrl(
    envOf({
      BASE_API_URL: "/api/",
      NEXT_PUBLIC_SERVER_URL: "https://sl.example.test",
    }),
  );
  expect(new URL(`${base}/admin/roles`).pathname).toBe("/api//admin/roles");
});

it("один хост без пути — он и есть база", () => {
  expect(
    slbackBaseUrl(
      envOf({ NEXT_PUBLIC_SERVER_URL: "https://sl.example.test/" }),
    ),
  ).toBe("https://sl.example.test");
});

it("пустые значения равнозначны незаданным: отказ с обоими именами", () => {
  const err = thrown(
    () =>
      slbackBaseUrl(envOf({ BASE_API_URL: "", NEXT_PUBLIC_SERVER_URL: "" })),
    DomainError,
  );
  expect(err.message).toStrictEqual(
    "sl-back base URL не задан. Поставь BASE_API_URL (full URL) или " +
      "NEXT_PUBLIC_SERVER_URL (host) + BASE_API_URL (path) в ~/.config/mpu/.env",
  );
});

it("path-префикс без хоста — тоже отказ адреса", () => {
  expect(() => slbackBaseUrl(envOf({ BASE_API_URL: "/api" }))).toThrow(
    DomainError,
  );
});

it("недостающие креды названы все сразу и в порядке спеки", () => {
  const err = thrown(() => slbackCredentials(envOf({})), DomainError);
  expect(err.message).toStrictEqual(
    "sl-back credentials missing: TOKEN_EMAIL, TOKEN_PASSWORD. " +
      "Add to ~/.config/mpu/.env or export in shell.",
  );
});

it("флаг закрывает свой ключ и побеждает env по своему полю", () => {
  const env = envOf({ TOKEN_EMAIL: "из-env@test", TOKEN_PASSWORD: "пароль" });
  expect(slbackCredentials(env, { email: "из-флага@test" })).toStrictEqual({
    email: "из-флага@test",
    password: "пароль",
  });
  expect(
    slbackCredentials(envOf({ TOKEN_PASSWORD: "пароль" }), {
      email: "из-флага@test",
    }),
  ).toStrictEqual({ email: "из-флага@test", password: "пароль" });
});

it("недостающим считается только пустой ключ", () => {
  const err = thrown(
    () => slbackCredentials(envOf({ TOKEN_EMAIL: "кто@test" })),
    DomainError,
  );
  expect(err.message).toStrictEqual(
    "sl-back credentials missing: TOKEN_PASSWORD. " +
      "Add to ~/.config/mpu/.env or export in shell.",
  );
});
