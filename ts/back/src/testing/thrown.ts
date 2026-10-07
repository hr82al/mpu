/**
 * Пойманная ошибка для проверок её полей — то, что прежде давали значения
 * `assertThrows` и `assertRejects`. У Vitest `toThrow` ничего не
 * возвращает, а `assert.throws` из chai объявлен `void`.
 *
 * Модуль подключают только тесты `*.test.ts`.
 */

import { assert, expect } from "vitest";

/** Класс ожидаемой ошибки. */
type ErrorClass<E extends Error> = new (...args: never[]) => E;

/**
 * Ошибка, брошенная `fn`. Краснеет, если `fn` не бросил, бросил не
 * экземпляр `kind` или текст ошибки не содержит `includes`.
 */
export function thrown<E extends Error>(
  fn: () => unknown,
  kind: ErrorClass<E>,
  includes?: string,
): E {
  try {
    fn();
  } catch (error) {
    return matching(error, kind, includes);
  }
  assert.fail("ожидалась ошибка, а её не было");
}

/**
 * Ошибка, которой отказал промис `fn`. Краснеет на исполненном промисе, на
 * отказе не тем классом или без `includes` в тексте; синхронный бросок
 * `fn` уходит наружу — тест красный, как и у `assertRejects`.
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
    return matching(error, kind, includes);
  }
  assert.fail("ожидался отказ, а промис исполнился");
}

function matching<E extends Error>(
  error: unknown,
  kind: ErrorClass<E>,
  includes: string | undefined,
): E {
  if (!(error instanceof kind)) {
    assert.fail(`ожидалась ${kind.name}, а пришло: ${String(error)}`);
  }
  if (includes !== undefined) expect(error.message).toContain(includes);
  return error;
}
