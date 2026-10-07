/**
 * Проба криптографии собранной программы (`platform/tslibs-telegram.md`,
 * [S.6]): бинарь `bun build --compile` этого входа поднимает wasm клиента
 * без сети и без файла рядом — байты приходят модулем `src/wasm_modules.ts`.
 * Без него бинарь падает «Cannot find module '@mtcute/wasm/mtcute-simd.wasm'».
 *
 * Собирает и запускает `bun run check:binary` (шаг `gate`) во временном
 * каталоге; успех — строка `ok` и код 0.
 */

import { telegramCrypto } from "../src/crypto.ts";

const crypto = telegramCrypto();
await crypto.initialize();
// Поднятый модуль ещё и считает: пустой вызов `initSync` не доказал бы, что
// байты — те.
const digest = crypto.sha256(new TextEncoder().encode("mpu"));
if (digest.length !== 32) {
  throw new Error(`sha256 вернул ${digest.length} байт`);
}
process.stdout.write("ok\n");
