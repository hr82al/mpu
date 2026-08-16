/**
 * Ошибки слоя Telegram (`docs/specs/platform/telegram-mtproto.md`,
 * «Ошибки и коды выхода»): одна строка вида `telegram: <причина>`, без
 * трейсбеков, с кодом 2 у ошибок ввода и 1 у прочих.
 *
 * Форму строки несёт сам слой, поэтому общий префикс точки входа
 * (`mpu <команда>: `) к ней не добавляется — отсюда дословные классы.
 */

import {
  type ErrorDetails,
  VerbatimError,
  VerbatimUsageError,
} from "../command/mod.ts";

/** Ошибка ввода: адресат, текст сообщения. Код выхода 2, до сети. */
export function inputError(
  reason: string,
  opts?: ErrorDetails,
): VerbatimUsageError {
  return new VerbatimUsageError(`telegram: ${reason}`, opts);
}

/** Ошибка конфигурации или отказ Telegram. Код выхода 1. */
export function configError(
  reason: string,
  opts?: ErrorDetails,
): VerbatimError {
  return new VerbatimError(`telegram: ${reason}`, opts);
}

/**
 * Отказ Telegram одной строкой: rate-limit со сроком ожидания, прочий
 * отказ протокола — его текстом.
 *
 * Различение — по полям отказа, не по тексту сообщения: срок ожидания
 * приходит числом `seconds`, текст протокола — полем `text`.
 */
export function telegramFailure(err: unknown): VerbatimError {
  const seconds = numberField(err, "seconds");
  if (seconds !== undefined) {
    return configError(`rate-limit, подожди ${seconds}s`, { cause: err });
  }
  return configError(`RPC error: ${protocolText(err)}`, { cause: err });
}

/** Текст отказа протокола: поле `text`, иначе сообщение ошибки. */
function protocolText(err: unknown): string {
  const text = stringField(err, "text");
  if (text !== undefined) return text;
  return err instanceof Error ? err.message : String(err);
}

function numberField(err: unknown, name: string): number | undefined {
  const value = field(err, name);
  return typeof value === "number" ? value : undefined;
}

function stringField(err: unknown, name: string): string | undefined {
  const value = field(err, name);
  return typeof value === "string" && value !== "" ? value : undefined;
}

function field(err: unknown, name: string): unknown {
  if (typeof err !== "object" || err === null) return undefined;
  return (err as Record<string, unknown>)[name];
}
