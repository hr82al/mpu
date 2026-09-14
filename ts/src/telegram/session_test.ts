/**
 * Вход в сеанс до сети (`docs/specs/platform/telegram-mtproto.md`,
 * «Конфигурация»): отказ импорта строки сессии называется своей причиной.
 * Сети эти случаи не касаются — оба отказа приходят до соединения.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { __getWasm } from "@mtcute/wasm";
import { VerbatimError } from "../command/mod.ts";
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

Deno.test("отказ входа до сети: сбой криптографии не выдаётся за «не авторизован»", async (t) => {
  const keys = { apiId: 1, apiHash: "проба" };

  await t.step(
    "встроенный модуль не прочитан — криптография не поднялась",
    async () => {
      // Совет пройти вход здесь вреден: вход отзывает действующую сессию.
      const realReadFile = Deno.readFile;
      Deno.readFile = () =>
        Promise.reject(
          new Deno.errors.NotFound("нет встроенного модуля\nподробности"),
        );
      try {
        const err = await assertRejects(
          () => openSession({ ...keys, session: acceptedSession() }),
          VerbatimError,
        );
        assertEquals(
          err.message,
          "telegram: криптография клиента не поднялась: нет встроенного модуля",
        );
      } finally {
        Deno.readFile = realReadFile;
      }
    },
  );

  await t.step(
    "модуль прочитан, но не принят — криптография не поднялась",
    async () => {
      // Предусловие: модуль ещё не поднят. `initSync` у поднятого — пустой
      // вызов, и тогда шаг не проверял бы разбор, а пошёл бы соединяться.
      assertEquals(
        __getWasm(),
        undefined,
        "модуль уже поднят выше в этом файле — шаг ничего не проверит",
      );
      const realReadFile = Deno.readFile;
      Deno.readFile = () => Promise.resolve(new Uint8Array([0, 1, 2, 3]));
      try {
        const err = await assertRejects(
          () => openSession({ ...keys, session: acceptedSession() }),
          VerbatimError,
        );
        assertStringIncludes(
          err.message,
          "telegram: криптография клиента не поднялась: ",
        );
        assertEquals(err.message.includes("\n"), false, err.message);
        // Цепочка причин: свой класс криптографии поверх отказа разбора
        // модуля. Проверяется здесь, а не в `crypto_test.ts`: `initSync`
        // ничего не делает, если модуль уже поднят, а там его поднимает
        // первый же тест файла; здесь до этого шага модуль не поднят.
        assertEquals(
          err.cause instanceof CryptoInitError,
          true,
          String(err.cause),
        );
        assertEquals(
          err.cause instanceof Error &&
            err.cause.cause instanceof WebAssembly.CompileError,
          true,
        );
      } finally {
        Deno.readFile = realReadFile;
      }
    },
  );

  await t.step("строка сессии не принята — не авторизован", async () => {
    const err = await assertRejects(
      () => openSession({ ...keys, session: "не-строка-сессии" }),
      VerbatimError,
    );
    assertEquals(err.message, "telegram: не авторизован; запусти `mpu init`");
  });
});
