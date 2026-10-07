import { describe, expect, it } from "vitest";
import { thrown } from "@mpu/testing/thrown";
import { TelegramError } from "./errors.ts";
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
        // Так отказывает адаптер потребителя: текст env-файла строкой слоя.
        throw new TelegramError(
          `telegram: environment variable ${name} is not set. ` +
            "Add it to /nowhere/.env or export in shell.",
        );
      }
      return value;
    },
  };
}

it("полная конфигурация", () => {
  expect(
    telegramConfig(
      env({
        ...FULL,
        TELEGRAM_PROXY: "socks5://10.0.0.1:1080",
      }),
    ),
  ).toStrictEqual({
    apiId: 12345,
    apiHash: "hash",
    session: "session-string",
    proxy: { tunnel: "socks5", host: "10.0.0.1", port: 1080 },
  });
});

it("прокси не задан — поля нет", () => {
  expect(telegramConfig(env(FULL)).proxy).toStrictEqual(undefined);
});

describe("отсутствующий обязательный ключ называет себя и путь", () => {
  for (const name of ["TELEGRAM_API_ID", "TELEGRAM_API_HASH"]) {
    it(name, () => {
      const values = { ...FULL, [name]: "" };
      const err = thrown(() => {
        telegramConfig(env(values));
      }, TelegramError);
      expect(err.message).toStrictEqual(
        `telegram: environment variable ${name} is not set. ` +
          "Add it to /nowhere/.env or export in shell.",
      );
    });
  }
});

it("нечисловой TELEGRAM_API_ID", () => {
  const err = thrown(() => {
    telegramConfig(env({ ...FULL, TELEGRAM_API_ID: "abc" }));
  }, TelegramError);
  expect(err.message).toBe(
    "telegram: TELEGRAM_API_ID должен быть числом, получено 'abc'",
  );
});

it("пустая строка сессии — не авторизован", () => {
  const err = thrown(() => {
    telegramConfig(env({ ...FULL, TELEGRAM_SESSION: "" }));
  }, TelegramError);
  expect(err.message).toBe("telegram: не авторизован; запусти `mpu init`");
});

describe("прокси берётся по порядку источников", () => {
  it("TELEGRAM_PROXY старше HTTPS_PROXY", () => {
    const config = telegramConfig(
      env({
        ...FULL,
        TELEGRAM_PROXY: "socks5://10.0.0.1:1080",
        HTTPS_PROXY: "http://proxy.example:3128",
      }),
    );
    expect(config.proxy?.host).toBe("10.0.0.1");
  });
  it("HTTPS_PROXY старше https_proxy", () => {
    const config = telegramConfig(
      env({
        ...FULL,
        HTTPS_PROXY: "http://upper.example:3128",
        https_proxy: "http://lower.example:3128",
      }),
    );
    expect(config.proxy?.host).toBe("upper.example");
  });
  it("https_proxy — последний источник", () => {
    const config = telegramConfig(
      env({
        ...FULL,
        https_proxy: "http://lower.example:3128",
      }),
    );
    expect(config.proxy?.host).toBe("lower.example");
  });
});

it("секреты не попадают в текст ошибки конфигурации", () => {
  const err = thrown(() => {
    telegramConfig(
      env({
        ...FULL,
        TELEGRAM_API_ID: "abc",
        TELEGRAM_API_HASH: "s3cret-hash",
      }),
    );
  }, TelegramError);
  expect(err.message.includes("s3cret-hash")).toBe(false);
  expect(err.message.includes("session-string")).toBe(false);
});
