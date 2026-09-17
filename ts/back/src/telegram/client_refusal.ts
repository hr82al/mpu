/**
 * Что считается отказом клиента Telegram (`docs/specs/platform/
 * telegram-mtproto.md`, «Что считается отказом Telegram / слоя клиента»).
 *
 * Различение — по типу ошибки, а классы библиотеки знает только модуль,
 * который её грузит: сюда ходят сеанс и вход, оба подгружаются лениво.
 * Лёгкий слой ошибок (`errors.ts`) библиотеку не импортирует — иначе старт
 * каждой команды тянул бы клиент с модулем криптографии.
 */

import { MtcuteError, tl } from "@mtcute/deno";
import { VerbatimError, VerbatimUsageError } from "../command/mod.ts";
import { CryptoInitError, layerFailure } from "./errors.ts";

/**
 * Отказ клиента — строкой слоя: отказ протокола (`tl.RpcError`), отказ
 * библиотеки (`MtcuteError` и наследники), сбой криптографии и уже
 * оформленный слоем отказ (в том числе по пределам соединения и первого
 * ответа). Прочее — дефект своего кода, отказ терминала или записи файла —
 * отдаётся тем же объектом: переоформлять его в `RPC error` значило бы
 * выдать ошибку программы за отказ Telegram.
 */
export function clientRefusal(err: unknown): unknown {
  const fromClient = err instanceof tl.RpcError ||
    err instanceof MtcuteError ||
    err instanceof CryptoInitError ||
    err instanceof VerbatimError ||
    err instanceof VerbatimUsageError;
  return fromClient ? layerFailure(err) : err;
}
