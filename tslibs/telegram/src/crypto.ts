/**
 * Криптография MTProto для живого клиента
 * (`platform/telegram-mtproto.md`, «Прокси»: во время работы
 * сеть — только узлы Telegram).
 *
 * Штатная инициализация криптографии берёт wasm по адресу рядом с модулем
 * зависимости: у собранной программы его там нет, а прежде (JSR) этот
 * адрес был `jsr.io`, и каждое открытие сеанса шло в реестр пакетов. Здесь
 * те же байты приходят модулем (`./wasm_modules.ts`) и попадают в
 * программу вместе с кодом (`platform/node-runtime.md`, [S.8]).
 */

import { Buffer } from "node:buffer";
import { NodeCryptoProvider } from "@mtcute/node/utils.js";
import { initSync, SIMD_AVAILABLE } from "@mtcute/wasm";
import { CryptoInitError } from "./errors.ts";
import { MTCUTE_SIMD_WASM, MTCUTE_WASM } from "./wasm_modules.ts";

/**
 * Провайдер криптографии клиента Telegram: всё от штатного, кроме
 * инициализации — модуль берётся из программы, а не из сети и не с диска.
 * Выбор между двумя сборками модуля тот же, что у библиотеки.
 */
export function telegramCrypto(): NodeCryptoProvider {
  const provider = new NodeCryptoProvider();
  provider.initialize = () => {
    try {
      initSync(
        Buffer.from(SIMD_AVAILABLE ? MTCUTE_SIMD_WASM : MTCUTE_WASM, "base64"),
      );
    } catch (err) {
      // Любой сбой здесь — криптография не поднялась, какого бы класса ни
      // был отказ разбора модуля.
      const reason = err instanceof Error ? err.message : String(err);
      return Promise.reject(new CryptoInitError(reason, { cause: err }));
    }
    return Promise.resolve();
  };
  return provider;
}
