/**
 * Резолв базового URL и кред sl-back (`platform/slback-http.md`):
 * четыре правила адреса по порядку и перечисление недостающих ключей.
 */

import { assertEquals, assertThrows } from "@std/assert";
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

Deno.test("BASE_API_URL как полный URL побеждает хост", () => {
  assertEquals(
    slbackBaseUrl(envOf({
      BASE_API_URL: "https://api.example.test/v2/",
      NEXT_PUBLIC_SERVER_URL: "https://другой.test",
    })),
    "https://api.example.test/v2",
  );
});

Deno.test("правило 2: у префикса срезаются ведущие слэши, у хоста — хвостовые", () => {
  assertEquals(
    slbackBaseUrl(envOf({
      BASE_API_URL: "/api/",
      NEXT_PUBLIC_SERVER_URL: "https://sl.example.test//",
    })),
    "https://sl.example.test/api/",
  );
});

Deno.test("хвостовой слэш префикса остаётся — и даёт `//` перед путём", () => {
  // Не украшательство, а буква спеки: адрес обязан совпадать с адресом
  // прежней реализации, иначе сверка сравнивала бы разные запросы.
  const base = slbackBaseUrl(envOf({
    BASE_API_URL: "/api/",
    NEXT_PUBLIC_SERVER_URL: "https://sl.example.test",
  }));
  assertEquals(new URL(`${base}/admin/roles`).pathname, "/api//admin/roles");
});

Deno.test("один хост без пути — он и есть база", () => {
  assertEquals(
    slbackBaseUrl(
      envOf({ NEXT_PUBLIC_SERVER_URL: "https://sl.example.test/" }),
    ),
    "https://sl.example.test",
  );
});

Deno.test("пустые значения равнозначны незаданным: отказ с обоими именами", () => {
  const err = assertThrows(
    () =>
      slbackBaseUrl(envOf({ BASE_API_URL: "", NEXT_PUBLIC_SERVER_URL: "" })),
    DomainError,
  );
  assertEquals(
    err.message,
    "sl-back base URL не задан. Поставь BASE_API_URL (full URL) или " +
      "NEXT_PUBLIC_SERVER_URL (host) + BASE_API_URL (path) в ~/.config/mpu/.env",
  );
});

Deno.test("path-префикс без хоста — тоже отказ адреса", () => {
  assertThrows(
    () => slbackBaseUrl(envOf({ BASE_API_URL: "/api" })),
    DomainError,
  );
});

Deno.test("недостающие креды названы все сразу и в порядке спеки", () => {
  const err = assertThrows(() => slbackCredentials(envOf({})), DomainError);
  assertEquals(
    err.message,
    "sl-back credentials missing: TOKEN_EMAIL, TOKEN_PASSWORD. " +
      "Add to ~/.config/mpu/.env or export in shell.",
  );
});

Deno.test("флаг закрывает свой ключ и побеждает env по своему полю", () => {
  const env = envOf({ TOKEN_EMAIL: "из-env@test", TOKEN_PASSWORD: "пароль" });
  assertEquals(slbackCredentials(env, { email: "из-флага@test" }), {
    email: "из-флага@test",
    password: "пароль",
  });
  assertEquals(
    slbackCredentials(envOf({ TOKEN_PASSWORD: "пароль" }), {
      email: "из-флага@test",
    }),
    { email: "из-флага@test", password: "пароль" },
  );
});

Deno.test("недостающим считается только пустой ключ", () => {
  const err = assertThrows(
    () => slbackCredentials(envOf({ TOKEN_EMAIL: "кто@test" })),
    DomainError,
  );
  assertEquals(
    err.message,
    "sl-back credentials missing: TOKEN_PASSWORD. " +
      "Add to ~/.config/mpu/.env or export in shell.",
  );
});
