/**
 * Конфигурация Telegram из env-файла для слоя команд
 * (`docs/specs/platform/telegram-mtproto.md`, «Конфигурация»;
 * `docs/specs/telegram-log.md`, «Конфигурация»): правила разбора — в
 * `@mpu/telegram`, здесь — env-файл в форме порта библиотеки.
 *
 * Порт отдаёт «ключа нет» уже строкой слоя: класс отказа env-файла
 * (`DomainError`) знает только слой команд, и различать его по типу можно
 * только здесь.
 */

import {
  type BotConfig,
  botConfig as readBotConfig,
  type EnvKeys as LayerEnvKeys,
  type TelegramConfig,
  TelegramError,
  telegramConfig as readTelegramConfig,
} from "@mpu/telegram";
import { DomainError, type EnvFile } from "@mpu/command";
import { commandError } from "./errors.ts";

/** Что из env-файла нужно конфигурации: чтение ключа и обязательный ключ. */
export type EnvKeys = Pick<EnvFile, "get" | "require">;

/** Конфигурация сеанса MTProto; непригодное значение — отказ слоя. */
export function telegramConfig(env: EnvKeys): TelegramConfig {
  return readTelegramConfig(telegramEnv(env));
}

/**
 * Конфигурация личного бота; непригодное значение — `VerbatimError`. Отказ
 * переведён здесь, а не в команде: по нему непригодную настройку различают
 * и вопросы владельцу (`../botquestions/`), у которых команды нет.
 */
export function botConfig(env: EnvKeys): BotConfig {
  try {
    return readBotConfig(telegramEnv(env));
  } catch (err) {
    throw commandError(err);
  }
}

/**
 * Env-файл портом библиотеки: отсутствие обязательного ключа — отказ слоя
 * `telegram: <текст env-файла>` (он называет ключ и путь). Прочий отказ
 * чтения — дефект — уходит тем же объектом.
 */
function telegramEnv(env: EnvKeys): LayerEnvKeys {
  return {
    get: (name) => env.get(name),
    require: (name) => {
      try {
        return env.require(name);
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        throw new TelegramError(`telegram: ${err.message}`, { cause: err });
      }
    },
  };
}
