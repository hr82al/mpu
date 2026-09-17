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

/**
 * Криптография клиента не поднялась: встроенный модуль не прочитан или не
 * принят (`crypto.ts`). Отказ приходит изнутри импорта строки сессии
 * (`session.ts`) или из первого обращения клиента — у сеанса и при входе
 * (`clientRefusal`, `client_refusal.ts`), и отличить его от непринятой
 * строки и от отказа протокола можно только по типу.
 * Лежит здесь, а не рядом с провайдером: слой ошибок лёгкий, и знание о
 * классе не тянет за собой клиент MTProto и его wasm.
 */
export class CryptoInitError extends Error {
  override name = "CryptoInitError";
}

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
function telegramFailure(err: unknown): VerbatimError {
  const seconds = numberField(err, "seconds");
  if (seconds !== undefined) {
    return configError(`rate-limit, подожди ${seconds}s`, { cause: err });
  }
  return configError(`RPC error: ${protocolText(err)}`, { cause: err });
}

/**
 * Криптография клиента не поднялась: первая строка причины, без советов —
 * совет пройти вход здесь вреден, вход отзывает действующую сессию
 * (`platform/telegram-mtproto.md`, «Конфигурация»). Текст один на все
 * подкоманды: и сеанс, и вход.
 */
export function cryptoFailure(err: CryptoInitError): VerbatimError {
  const reason = err.message.split("\n")[0];
  return configError(`криптография клиента не поднялась: ${reason}`, {
    cause: err,
  });
}

/**
 * Отказ клиента одной строкой слоя: сбой криптографии — своим текстом,
 * своё оформление слоя — как есть, прочее — отказ протокола. Что считается
 * отказом клиента, решает `clientRefusal` (`client_refusal.ts`) — только
 * он сюда и ходит: без различения по типу сюда попал бы и дефект своего
 * кода.
 */
export function layerFailure(
  err: unknown,
): VerbatimError | VerbatimUsageError {
  if (err instanceof CryptoInitError) return cryptoFailure(err);
  // Своё оформление слоя — и доменное, и ошибка ввода: второй слой
  // обёртки не только исказил бы текст, но и понизил бы код 2 до 1.
  return err instanceof VerbatimError || err instanceof VerbatimUsageError
    ? err
    : telegramFailure(err);
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
