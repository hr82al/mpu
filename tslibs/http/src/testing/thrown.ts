/**
 * Отказ промиса для проверок полей ошибки: у Vitest `rejects.toThrow`
 * ничего не возвращает. Копия используемой части `back/src/testing/thrown.ts`
 * mpu: библиотека собирается и тестируется без `ts/`.
 *
 * Модуль подключают только тесты; в `dist/` он не попадает.
 */

import { assert, expect } from "vitest";

/** Класс ожидаемой ошибки. */
type ErrorClass<E extends Error> = new (...args: never[]) => E;

/**
 * Ошибка, которой отказал промис `fn`. Краснеет на исполненном промисе, на
 * отказе не тем классом или без `includes` в тексте.
 */
export async function rejected<E extends Error>(
  fn: () => PromiseLike<unknown>,
  kind: ErrorClass<E>,
  includes?: string,
): Promise<E> {
  const pending = fn();
  try {
    await pending;
  } catch (error) {
    if (!(error instanceof kind)) {
      assert.fail(`ожидалась ${kind.name}, а пришло: ${String(error)}`);
    }
    if (includes !== undefined) expect(error.message).toContain(includes);
    return error;
  }
  assert.fail("ожидался отказ, а промис исполнился");
}
