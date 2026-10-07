/**
 * Криптография MTProto поднимается без сети
 * (`docs/specs/platform/telegram-mtproto.md`, «Прокси»: во время работы
 * сеть — только узлы Telegram).
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { __getWasm } from "@mtcute/wasm";
import { describe, expect, it } from "vitest";
import { rejected } from "../testing/thrown.ts";
import { telegramCrypto } from "./crypto.ts";
import { CryptoInitError } from "./errors.ts";
import { MTCUTE_SIMD_WASM, MTCUTE_WASM } from "./wasm_modules.ts";

/** Пакет `@mtcute/wasm`, который ставит `package.json`. */
const PACKAGE = new URL("../../../node_modules/@mtcute/wasm/", import.meta.url);

describe("встроенный модуль не прочитан — свой отказ криптографии, а не отказ библиотеки", () => {
  // Отказ приходит в сеанс изнутри импорта строки сессии: отличить его от
  // непринятой строки можно только по типу (`session.ts`).
  //
  // Байты модуля встроены, читать нечего; сбой подделывается в
  // `WebAssembly.Module`, которым `initSync` разбирает модуль. Эти случаи —
  // первые в файле: `initSync` разбирает модуль лишь до первой удачи на
  // экземпляр `@mtcute/wasm`, а экземпляр у файла один (Vitest изолирует
  // граф модулей по файлам).
  const refusals = [
    ["модуль не найден в сборке", () => new Error("нет встроенного модуля")],
    ["модуль испорчен", () => compileError(new Uint8Array([0, 1, 2, 3]))],
  ] as const;
  for (const [name, refusal] of refusals) {
    it(name, async () => {
      expect(__getWasm(), "модуль уже поднят — случай ничего не проверит").toBe(
        undefined,
      );
      const cause = refusal();
      const real = WebAssembly.Module;
      Reflect.set(WebAssembly, "Module", function () {
        throw cause;
      });
      try {
        const err = await rejected(
          () => telegramCrypto().initialize(),
          CryptoInitError,
        );
        expect(err.cause).toBe(cause);
      } finally {
        Reflect.set(WebAssembly, "Module", real);
      }
    });
  }
});

/** Отказ разбора настоящего модуля на негодных байтах. */
function compileError(bytes: Uint8Array<ArrayBuffer>): unknown {
  try {
    new WebAssembly.Module(bytes);
  } catch (err) {
    return err;
  }
  throw new Error("негодные байты разобрались как модуль");
}

it("криптография Telegram поднимается без сети: wasm не скачивается по адресу зависимости", async () => {
  // Штатная инициализация берёт модуль по адресу рядом с зависимостью, а у
  // собранной программы там ничего нет. Подмена `fetch` отказывает и
  // запоминает, куда просились.
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
  expect(
    asked,
    `инициализация ходила в сеть: ${String(failure)}`,
  ).toStrictEqual([]);
  expect(failure).toStrictEqual(undefined);
  // Модуль в деле: шифр IGE, ради которого wasm и грузится, обратим.
  const key = new Uint8Array(32).fill(7);
  const iv = new Uint8Array(32).fill(3);
  const data = new Uint8Array(32).fill(42);
  const sealed = provider.createAesIge(key, iv).encrypt(data);
  expect(sealed).not.toStrictEqual(data);
  expect(provider.createAesIge(key, iv).decrypt(sealed)).toStrictEqual(data);
});

describe("встроенный wasm — ровно тот, что у @mtcute/wasm 0.31.0", () => {
  // Суммы — из манифеста пакета на jsr.io (`@mtcute/wasm/0.31.0_meta.json`);
  // npm-сборка той же версии несёт те же байты. Модуль порождается из
  // поставленного пакета (`back/scripts/gen-wasm-modules.ts`, установка и
  // сборка); сверка с файлом пакета ловит модуль, не пересобранный после
  // бампа, а суммы — сам бамп. Расхождение с версией, которую берёт сам
  // `@mtcute/node` (`^0.31.0`), ловит первый тест — шифр IGE работает,
  // лишь если клиент и мы делим один экземпляр модуля.
  const cases = [
    [
      "mtcute.wasm",
      MTCUTE_WASM,
      "cd5817cabd16835353b52fba26d0afa4a0c7bfd19a6993251331aa8f0894ad30",
    ],
    [
      "mtcute-simd.wasm",
      MTCUTE_SIMD_WASM,
      "a50729e55eac1cf6b251e1379080dbb7a761a6f1ec36c653d20561ded43bfb1c",
    ],
  ] as const;
  for (const [name, embedded, sum] of cases) {
    it(name, async () => {
      const manifest = JSON.parse(
        await readFile(new URL("package.json", PACKAGE), "utf8"),
      );
      expect(manifest.version, "версия пакета").toBe("0.31.0");
      const bytes = Buffer.from(embedded, "base64");
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(sum);
      expect(
        bytes.equals(await readFile(new URL(name, PACKAGE))),
        "файл пакета",
      ).toBe(true);
    });
  }
});
