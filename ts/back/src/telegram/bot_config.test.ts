/**
 * Конфигурация бота (`docs/specs/telegram-log.md`, «Конфигурация»):
 * свои ключи, не пересекающиеся с сеансом MTProto.
 */

import { describe, expect, it } from "vitest";
import { thrown } from "../testing/thrown.ts";
import { DomainError } from "../command/mod.ts";
import { botConfig } from "./bot_config.ts";
import type { EnvKeys } from "./config.ts";

/** Env поверх словаря: пустое значение равнозначно незаданному ключу. */
function fakeEnv(values: Readonly<Record<string, string>>): EnvKeys {
  return {
    get: (name) => values[name],
    require: (name) => {
      const value = values[name];
      if (value === undefined || value === "") {
        throw new DomainError(
          `environment variable ${name} is not set. Add it to /tmp/.env or export in shell.`,
        );
      }
      return value;
    },
  };
}

it("оба обязательных ключа заданы — конфигурация собрана", () => {
  const config = botConfig(
    fakeEnv({
      TELEGRAM_BOT_TOKEN: "8123456789:AAH-token",
      TELEGRAM_BOT_ID: "987654321",
      TELEGRAM_BOT_NAME: "my_notes_bot",
    }),
  );
  expect(config.token).toBe("8123456789:AAH-token");
  expect(config.chatId).toBe(987654321);
  expect(config.botName).toBe("my_notes_bot");
});

it("имя бота необязательно — поля нет", () => {
  const config = botConfig(
    fakeEnv({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_BOT_ID: "1" }),
  );
  expect(config.botName).toStrictEqual(undefined);
});

it("пустое имя бота равнозначно незаданному", () => {
  const config = botConfig(
    fakeEnv({
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_BOT_ID: "1",
      TELEGRAM_BOT_NAME: "",
    }),
  );
  expect(config.botName).toStrictEqual(undefined);
});

it("нет токена — ошибка конфигурации с именем ключа", () => {
  const err = thrown(() => {
    botConfig(fakeEnv({ TELEGRAM_BOT_ID: "1" }));
  }, DomainError);
  expect(err.message.includes("TELEGRAM_BOT_TOKEN")).toBe(true);
});

it("нет id — ошибка конфигурации с именем ключа", () => {
  const err = thrown(() => {
    botConfig(fakeEnv({ TELEGRAM_BOT_TOKEN: "t" }));
  }, DomainError);
  expect(err.message.includes("TELEGRAM_BOT_ID")).toBe(true);
});

it("нечисловой id — свой текст отказа", () => {
  const err = thrown(() => {
    botConfig(fakeEnv({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_BOT_ID: "меня" }));
  }, DomainError);
  expect(err.message).toBe(
    "telegram: TELEGRAM_BOT_ID должен быть числом, получено 'меня'",
  );
});

it("отрицательный id принимается — так выглядят группы", () => {
  const config = botConfig(
    fakeEnv({
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_BOT_ID: "-1001234567890",
    }),
  );
  expect(config.chatId).toBe(-1001234567890);
});

it("прокси берётся из TELEGRAM_PROXY", () => {
  const config = botConfig(
    fakeEnv({
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_BOT_ID: "1",
      TELEGRAM_PROXY: "socks5://user:pass@host:1080",
    }),
  );
  expect(config.proxy).toBe("socks5://user:pass@host:1080");
});

it("прокси не задан — поля нет", () => {
  const config = botConfig(
    fakeEnv({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_BOT_ID: "1" }),
  );
  expect(config.proxy).toStrictEqual(undefined);
});

it("TELEGRAM_PROXY старше HTTPS_PROXY", () => {
  const config = botConfig(
    fakeEnv({
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_BOT_ID: "1",
      TELEGRAM_PROXY: "socks5://свой:1080",
      HTTPS_PROXY: "http://общий:8080",
    }),
  );
  expect(config.proxy).toBe("socks5://свой:1080");
});

it("без TELEGRAM_PROXY берётся HTTPS_PROXY, затем https_proxy", () => {
  expect(
    botConfig(
      fakeEnv({
        TELEGRAM_BOT_TOKEN: "t",
        TELEGRAM_BOT_ID: "1",
        HTTPS_PROXY: "http://верхний:8080",
        https_proxy: "http://нижний:8080",
      }),
    ).proxy,
  ).toBe("http://верхний:8080");
  expect(
    botConfig(
      fakeEnv({
        TELEGRAM_BOT_TOKEN: "t",
        TELEGRAM_BOT_ID: "1",
        https_proxy: "http://нижний:8080",
      }),
    ).proxy,
  ).toBe("http://нижний:8080");
});

it("socks4 — отказ, названный своей причиной", () => {
  const err = thrown(() => {
    botConfig(
      fakeEnv({
        TELEGRAM_BOT_TOKEN: "t",
        TELEGRAM_BOT_ID: "1",
        TELEGRAM_PROXY: "socks4://host:1080",
      }),
    );
  }, DomainError);
  expect(err.message).toStrictEqual(
    "telegram: Bot API не умеет прокси socks4; поддерживаются" +
      " http/https/socks5/socks5h (у mpu telegram send прокси свой," +
      " через MTProto, и socks4 там работает)",
  );
});

it("прокси без host:port — отказ до сети", () => {
  const err = thrown(() => {
    botConfig(
      fakeEnv({
        TELEGRAM_BOT_TOKEN: "t",
        TELEGRAM_BOT_ID: "1",
        TELEGRAM_PROXY: "socks5://",
      }),
    );
  }, DomainError);
  expect(err.message).toBe(
    "telegram: в прокси-URL нужен host:port — 'socks5://'",
  );
});

describe("учётные данные прокси не попадают в текст отказа", () => {
  for (const [proxy, shown] of [
    ["http://u:p'a ss@[h:1", "прокси-URL неразбираем — '[h:1'"],
    ["http://u:p'a ss@h", "в прокси-URL нужен host:port — 'http://h/'"],
  ]) {
    it(proxy, () => {
      const err = thrown(() => {
        botConfig(
          fakeEnv({
            TELEGRAM_BOT_TOKEN: "t",
            TELEGRAM_BOT_ID: "1",
            TELEGRAM_PROXY: proxy,
          }),
        );
      }, DomainError);
      expect(err.message).toStrictEqual(`telegram: ${shown}`);
    });
  }
});
