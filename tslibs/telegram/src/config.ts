/**
 * Конфигурация сеанса Telegram из env-файла
 * (`platform/telegram-mtproto.md`, «Конфигурация»).
 */

import { configError } from "./errors.ts";
import { parseProxy, type ProxySettings } from "./proxy.ts";

/** Что из env-файла нужно конфигурации: чтение ключа и обязательный ключ. */
export interface EnvKeys {
  /** Значение ключа; ключа нет — `undefined`. */
  readonly get: (name: string) => string | undefined;
  /**
   * Значение обязательного ключа. Нет его или он пуст — бросает отказ
   * потребителя, чей текст называет ключ и файл; слой его не переоформляет:
   * класс отказа знает только тот, кто читает env-файл.
   */
  readonly require: (name: string) => string;
}

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
   * ввода (код 2) — порядок держит команда отправки потребителя.
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
  const apiId = env.require("TELEGRAM_API_ID");
  if (!/^\d+$/.test(apiId)) {
    throw configError(
      `TELEGRAM_API_ID должен быть числом, получено '${apiId}'`,
    );
  }
  const apiHash = env.require("TELEGRAM_API_HASH");
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

function proxyValue(env: EnvKeys): string | undefined {
  for (const key of PROXY_KEYS) {
    const value = env.get(key);
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}
