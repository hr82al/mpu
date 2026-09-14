/**
 * Криптография MTProto поднимается без сети
 * (`docs/specs/platform/telegram-mtproto.md`, «Прокси»: во время работы
 * сеть — только узлы Telegram).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { telegramCrypto } from "./crypto.ts";

Deno.test("криптография Telegram поднимается без сети: wasm не скачивается по адресу зависимости", async () => {
  // У собранной программы адрес модуля зависимости — `jsr.io`, поэтому
  // любой `fetch` при открытии сеанса — сеть мимо узлов Telegram. Подмена
  // отказывает и запоминает, куда просились.
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    asked.push(input instanceof Request ? input.url : String(input));
    return Promise.reject(new TypeError("сеть в тесте запрещена"));
  };
  const provider = telegramCrypto();
  let failure: unknown;
  try {
    await provider.initialize().catch((err: unknown) => {
      failure = err;
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(asked, [], `инициализация ходила в сеть: ${String(failure)}`);
  assertEquals(failure, undefined);
  // Модуль в деле: шифр IGE, ради которого wasm и грузится, обратим.
  const key = new Uint8Array(32).fill(7);
  const iv = new Uint8Array(32).fill(3);
  const data = new Uint8Array(32).fill(42);
  const sealed = provider.createAesIge(key, iv).encrypt(data);
  assertNotEquals(sealed, data);
  assertEquals(provider.createAesIge(key, iv).decrypt(sealed), data);
});

Deno.test("встроенный wasm — ровно тот, что у @mtcute/wasm 0.31.0", async (t) => {
  // Суммы — из манифеста пакета на jsr.io (`@mtcute/wasm/0.31.0_meta.json`).
  // Модуль лежит в репозитории, а привязки к нему — в библиотеке: смена её
  // версии без смены модуля развела бы их молча. Поэтому сначала — что
  // версия, которой шифрует программа, та самая.
  assertEquals(
    import.meta.resolve("@mtcute/wasm"),
    "https://jsr.io/@mtcute/wasm/0.31.0/index.ts",
  );
  const expected = {
    "mtcute.wasm":
      "cd5817cabd16835353b52fba26d0afa4a0c7bfd19a6993251331aa8f0894ad30",
    "mtcute-simd.wasm":
      "a50729e55eac1cf6b251e1379080dbb7a761a6f1ec36c653d20561ded43bfb1c",
  };
  for (const [name, sum] of Object.entries(expected)) {
    await t.step(name, async () => {
      const bytes = await Deno.readFile(new URL(`./${name}`, import.meta.url));
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", bytes),
      );
      const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0"))
        .join("");
      assertEquals(hex, sum);
    });
  }
});
