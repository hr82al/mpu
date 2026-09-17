import { assertEquals, assertThrows } from "@std/assert";
import { DomainError, VerbatimError } from "../command/mod.ts";
import { type EnvKeys, telegramConfig } from "./config.ts";

const FULL: Readonly<Record<string, string>> = {
  TELEGRAM_API_ID: "12345",
  TELEGRAM_API_HASH: "hash",
  TELEGRAM_SESSION: "session-string",
};

function env(values: Readonly<Record<string, string>>): EnvKeys {
  return {
    get: (name) => {
      const value = values[name];
      return value === undefined || value === "" ? undefined : value;
    },
    require: (name) => {
      const value = values[name];
      if (value === undefined || value === "") {
        throw new DomainError(
          `environment variable ${name} is not set. ` +
            "Add it to /nowhere/.env or export in shell.",
        );
      }
      return value;
    },
  };
}

Deno.test("полная конфигурация", () => {
  assertEquals(
    telegramConfig(env({
      ...FULL,
      TELEGRAM_PROXY: "socks5://10.0.0.1:1080",
    })),
    {
      apiId: 12345,
      apiHash: "hash",
      session: "session-string",
      proxy: { tunnel: "socks5", host: "10.0.0.1", port: 1080 },
    },
  );
});

Deno.test("прокси не задан — поля нет", () => {
  assertEquals(telegramConfig(env(FULL)).proxy, undefined);
});

Deno.test("отсутствующий обязательный ключ называет себя и путь", async (t) => {
  for (const name of ["TELEGRAM_API_ID", "TELEGRAM_API_HASH"]) {
    await t.step(name, () => {
      const values = { ...FULL, [name]: "" };
      const err = assertThrows(
        () => telegramConfig(env(values)),
        VerbatimError,
      );
      assertEquals(
        err.message,
        `telegram: environment variable ${name} is not set. ` +
          "Add it to /nowhere/.env or export in shell.",
      );
    });
  }
});

Deno.test("нечисловой TELEGRAM_API_ID", () => {
  const err = assertThrows(
    () => telegramConfig(env({ ...FULL, TELEGRAM_API_ID: "abc" })),
    VerbatimError,
  );
  assertEquals(
    err.message,
    "telegram: TELEGRAM_API_ID должен быть числом, получено 'abc'",
  );
});

Deno.test("пустая строка сессии — не авторизован", () => {
  const err = assertThrows(
    () => telegramConfig(env({ ...FULL, TELEGRAM_SESSION: "" })),
    VerbatimError,
  );
  assertEquals(err.message, "telegram: не авторизован; запусти `mpu init`");
});

Deno.test("прокси берётся по порядку источников", async (t) => {
  await t.step("TELEGRAM_PROXY старше HTTPS_PROXY", () => {
    const config = telegramConfig(env({
      ...FULL,
      TELEGRAM_PROXY: "socks5://10.0.0.1:1080",
      HTTPS_PROXY: "http://proxy.example:3128",
    }));
    assertEquals(config.proxy?.host, "10.0.0.1");
  });
  await t.step("HTTPS_PROXY старше https_proxy", () => {
    const config = telegramConfig(env({
      ...FULL,
      HTTPS_PROXY: "http://upper.example:3128",
      https_proxy: "http://lower.example:3128",
    }));
    assertEquals(config.proxy?.host, "upper.example");
  });
  await t.step("https_proxy — последний источник", () => {
    const config = telegramConfig(env({
      ...FULL,
      https_proxy: "http://lower.example:3128",
    }));
    assertEquals(config.proxy?.host, "lower.example");
  });
});

Deno.test("секреты не попадают в текст ошибки конфигурации", () => {
  const err = assertThrows(
    () =>
      telegramConfig(env({
        ...FULL,
        TELEGRAM_API_ID: "abc",
        TELEGRAM_API_HASH: "s3cret-hash",
      })),
    VerbatimError,
  );
  assertEquals(err.message.includes("s3cret-hash"), false);
  assertEquals(err.message.includes("session-string"), false);
});
