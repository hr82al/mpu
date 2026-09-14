/**
 * Криптография MTProto для живого клиента
 * (`docs/specs/platform/telegram-mtproto.md`, «Прокси»: во время работы
 * сеть — только узлы Telegram).
 *
 * Штатный провайдер `@mtcute/deno` при инициализации скачивает wasm по
 * адресу рядом с модулем зависимости, а у собранной программы этот адрес —
 * `jsr.io`: каждое открытие сеанса шло в реестр пакетов и без прокси в
 * окружении процесса висело. Здесь те же байты лежат рядом с этим файлом и
 * попадают в бинарь через `--include` задачи `build`.
 */

import { DenoCryptoProvider } from "@mtcute/deno";
import { initSync, SIMD_AVAILABLE } from "@mtcute/wasm";

/**
 * Криптография клиента не поднялась: встроенный модуль не прочитан или не
 * принят. Отказ приходит изнутри импорта строки сессии, и отличить его от
 * непринятой строки можно только по типу (`session.ts`).
 */
export class CryptoInitError extends Error {
  override name = "CryptoInitError";
}

/**
 * Провайдер криптографии клиента Telegram: всё от штатного, кроме
 * инициализации — модуль читается из собранной программы, а не из сети.
 * Выбор между двумя сборками модуля тот же, что у библиотеки.
 */
export function telegramCrypto(): DenoCryptoProvider {
  const provider = new DenoCryptoProvider();
  provider.initialize = async () => {
    const name = SIMD_AVAILABLE ? "mtcute-simd.wasm" : "mtcute.wasm";
    try {
      initSync(await Deno.readFile(new URL(`./${name}`, import.meta.url)));
    } catch (err) {
      // Любой сбой здесь — криптография не поднялась, какого бы класса ни
      // был отказ чтения или разбора модуля.
      const reason = err instanceof Error ? err.message : String(err);
      throw new CryptoInitError(reason, { cause: err });
    }
  };
  return provider;
}
