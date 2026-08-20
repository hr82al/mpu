/**
 * Конфигурация отправки в личного бота (`docs/specs/telegram-log.md`,
 * «Конфигурация»).
 *
 * Отдельно от `telegramConfig()`: у сеанса MTProto свои обязательные
 * ключи, и смешение сделало бы отправку в бота заложником входа
 * `mpu init` — она от сессии не зависит вовсе.
 */

import { DomainError } from "../command/mod.ts";
import type { EnvKeys } from "./config.ts";
import { configError } from "./errors.ts";

/** Разобранная конфигурация бота. */
export interface BotConfig {
  readonly token: string;
  /** Единственный адресат; выбор чата команде недоступен по построению. */
  readonly chatId: number;
  /** Username бота; нужен только подсказке в тексте отказа доставки. */
  readonly botName?: string;
}

/** Читает конфигурацию; непригодное значение — ошибка конфигурации. */
export function botConfig(env: EnvKeys): BotConfig {
  const token = required(env, "TELEGRAM_BOT_TOKEN");
  const chatId = required(env, "TELEGRAM_BOT_ID");
  // Минус в начале — обычный вид id группы или канала, поэтому знак
  // разрешён; всё прочее означает, что в ключе лежит не идентификатор.
  if (!/^-?\d+$/.test(chatId)) {
    throw configError(
      `TELEGRAM_BOT_ID должен быть числом, получено '${chatId}'`,
    );
  }
  const botName = env.get("TELEGRAM_BOT_NAME");
  return {
    token,
    chatId: Number(chatId),
    // Пустое значение равнозначно незаданному — поле не заводится.
    ...(botName === undefined || botName === "" ? {} : { botName }),
  };
}

/** Обязательный ключ: сообщение слоя env-файла несёт имя ключа и путь. */
function required(env: EnvKeys, name: string): string {
  try {
    return env.require(name);
  } catch (err) {
    if (err instanceof DomainError) {
      throw configError(err.message, { cause: err });
    }
    throw err;
  }
}
