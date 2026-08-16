/**
 * Конфигурация сеанса Telegram из env-файла
 * (`docs/specs/platform/telegram-mtproto.md`, «Конфигурация»).
 */

import { DomainError, type EnvFile } from "../command/mod.ts";
import { configError } from "./errors.ts";
import { parseProxy, type ProxySettings } from "./proxy.ts";

/** Что из env-файла нужно конфигурации: чтение ключа и обязательный ключ. */
export type EnvKeys = Pick<EnvFile, "get" | "require">;

/** Разобранная конфигурация сеанса. */
export interface TelegramConfig {
  readonly apiId: number;
  readonly apiHash: string;
  /**
   * Строка сессии как её записал вход `mpu init`. Принимается как есть и
   * никогда не переписывается: ту же строку читает прежняя реализация,
   * пока переезд не закончен.
   */
  readonly session: string;
  /**
   * Прокси только для Telegram; не задан ни одним источником — поля нет.
   * Адресата по умолчанию здесь нет намеренно: он читается раньше
   * конфигурации, иначе отказ конфигурации (код 1) обгонял бы ошибку
   * ввода (код 2) — см. `cmd_send.ts`.
   */
  readonly proxy?: ProxySettings;
}

/**
 * Источники прокси по старшинству. `HTTPS_PROXY` из env-файла проксирует
 * весь инструмент, а не только Telegram — ловушка оставлена видимой
 * (там же, «Прокси»).
 */
const PROXY_KEYS = ["TELEGRAM_PROXY", "HTTPS_PROXY", "https_proxy"] as const;

/** Читает конфигурацию; непригодное значение — ошибка конфигурации. */
export function telegramConfig(env: EnvKeys): TelegramConfig {
  const apiId = required(env, "TELEGRAM_API_ID");
  if (!/^\d+$/.test(apiId)) {
    throw configError(
      `TELEGRAM_API_ID должен быть числом, получено '${apiId}'`,
    );
  }
  const apiHash = required(env, "TELEGRAM_API_HASH");
  const session = env.get("TELEGRAM_SESSION");
  if (session === undefined || session === "") {
    throw configError("не авторизован; запусти `mpu init`");
  }
  const proxy = proxyValue(env);
  return {
    apiId: Number(apiId),
    apiHash,
    session,
    // Пустое значение равнозначно незаданному, поэтому поле не заводится.
    ...(proxy === undefined ? {} : { proxy: parseProxy(proxy) }),
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

function proxyValue(env: EnvKeys): string | undefined {
  for (const key of PROXY_KEYS) {
    const value = env.get(key);
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}
