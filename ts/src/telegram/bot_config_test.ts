/**
 * Конфигурация бота (`docs/specs/telegram-log.md`, «Конфигурация»):
 * свои ключи, не пересекающиеся с сеансом MTProto.
 */

import { assertEquals, assertThrows } from "@std/assert";
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

Deno.test("оба обязательных ключа заданы — конфигурация собрана", () => {
  const config = botConfig(fakeEnv({
    TELEGRAM_BOT_TOKEN: "8123456789:AAH-token",
    TELEGRAM_BOT_ID: "987654321",
    TELEGRAM_BOT_NAME: "my_notes_bot",
  }));
  assertEquals(config.token, "8123456789:AAH-token");
  assertEquals(config.chatId, 987654321);
  assertEquals(config.botName, "my_notes_bot");
});

Deno.test("имя бота необязательно — поля нет", () => {
  const config = botConfig(
    fakeEnv({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_BOT_ID: "1" }),
  );
  assertEquals(config.botName, undefined);
});

Deno.test("пустое имя бота равнозначно незаданному", () => {
  const config = botConfig(fakeEnv({
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_BOT_ID: "1",
    TELEGRAM_BOT_NAME: "",
  }));
  assertEquals(config.botName, undefined);
});

Deno.test("нет токена — ошибка конфигурации с именем ключа", () => {
  const err = assertThrows(
    () => botConfig(fakeEnv({ TELEGRAM_BOT_ID: "1" })),
    DomainError,
  );
  assertEquals(err.message.includes("TELEGRAM_BOT_TOKEN"), true);
});

Deno.test("нет id — ошибка конфигурации с именем ключа", () => {
  const err = assertThrows(
    () => botConfig(fakeEnv({ TELEGRAM_BOT_TOKEN: "t" })),
    DomainError,
  );
  assertEquals(err.message.includes("TELEGRAM_BOT_ID"), true);
});

Deno.test("нечисловой id — свой текст отказа", () => {
  const err = assertThrows(
    () =>
      botConfig(fakeEnv({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_BOT_ID: "меня" })),
    DomainError,
  );
  assertEquals(
    err.message,
    "telegram: TELEGRAM_BOT_ID должен быть числом, получено 'меня'",
  );
});

Deno.test("отрицательный id принимается — так выглядят группы", () => {
  const config = botConfig(fakeEnv({
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_BOT_ID: "-1001234567890",
  }));
  assertEquals(config.chatId, -1001234567890);
});
