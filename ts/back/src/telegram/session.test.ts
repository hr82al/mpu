/**
 * Вход в сеанс до сети (`docs/specs/platform/telegram-mtproto.md`,
 * «Конфигурация»): отказ импорта строки сессии называется своей причиной.
 * Сети эти случаи не касаются — оба отказа приходят до соединения.
 */

import { __getWasm } from "@mtcute/wasm";
import { describe, expect, it } from "vitest";
import { VerbatimError } from "../command/mod.ts";
import { rejected } from "@mpu/testing/thrown";
import { CryptoInitError } from "./errors.ts";
import { openSession } from "./session.ts";

/**
 * Строка сессии в формате прежней реализации (Telethon: версия `1` и
 * base64url от номера DC, IPv4, порта и 256-байтного ключа). Конвертер её
 * принимает, так что отказ импорта приходит не из разбора строки; до
 * соединения с узлом дело в этих тестах не доходит.
 */
function acceptedSession(): string {
  const bytes = new Uint8Array(1 + 4 + 2 + 256);
  bytes.set([2, 127, 0, 0, 1, 0, 1]);
  const base64 = btoa(String.fromCharCode(...bytes));
  return `1${base64.replaceAll("+", "-").replaceAll("/", "_")}`;
}

/**
 * Разбор wasm отказывает `refusal` на время `run`: байты модуля встроены, читать
 * нечего, и сбой криптографии подделывается в `WebAssembly.Module`, которым
 * его разбирает `initSync`.
 */
async function withModuleRefused(
  refusal: unknown,
  run: () => Promise<void>,
): Promise<void> {
  const real = WebAssembly.Module;
  Reflect.set(WebAssembly, "Module", function () {
    throw refusal;
  });
  try {
    await run();
  } finally {
    Reflect.set(WebAssembly, "Module", real);
  }
}

describe("отказ входа до сети: сбой криптографии не выдаётся за «не авторизован»", () => {
  const keys = { apiId: 1, apiHash: "проба" };

  // Оба случая сбоя криптографии требуют не поднятого модуля: `initSync` у
  // поднятого — пустой вызов, и тогда случай не проверял бы разбор, а пошёл
  // бы соединяться. Модуль поднимается только удачей, а её в этом файле нет.
  it("встроенный модуль не прочитан — криптография не поднялась", async () => {
    expect(__getWasm(), "модуль уже поднят — случай ничего не проверит").toBe(
      undefined,
    );
    // Совет пройти вход здесь вреден: вход отзывает действующую сессию.
    await withModuleRefused(
      new Error("нет встроенного модуля\nподробности"),
      async () => {
        const err = await rejected(
          () => openSession({ ...keys, session: acceptedSession() }),
          VerbatimError,
        );
        expect(err.message).toBe(
          "telegram: криптография клиента не поднялась: нет встроенного модуля",
        );
      },
    );
  });

  it("модуль прочитан, но не принят — криптография не поднялась", async () => {
    expect(__getWasm(), "модуль уже поднят — случай ничего не проверит").toBe(
      undefined,
    );
    // Отказ — `CompileError` движка на негодных байтах; снят до подмены,
    // иначе разбор попал бы в саму подмену.
    const refusal = compileError(new Uint8Array([0, 1, 2, 3]));
    await withModuleRefused(refusal, async () => {
      const err = await rejected(
        () => openSession({ ...keys, session: acceptedSession() }),
        VerbatimError,
      );
      expect(err.message).toContain(
        "telegram: криптография клиента не поднялась: ",
      );
      expect(err.message.includes("\n"), err.message).toBe(false);
      // Цепочка причин: свой класс криптографии поверх отказа разбора
      // модуля.
      expect(err.cause instanceof CryptoInitError, String(err.cause)).toBe(
        true,
      );
      expect(
        err.cause instanceof Error &&
          err.cause.cause instanceof WebAssembly.CompileError,
      ).toBe(true);
    });
  });

  it("строка сессии не принята — не авторизован", async () => {
    const err = await rejected(
      () => openSession({ ...keys, session: "не-строка-сессии" }),
      VerbatimError,
    );
    expect(err.message).toBe("telegram: не авторизован; запусти `mpu init`");
  });
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
