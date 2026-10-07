/**
 * Области тестов Vitest, которых у него нет готовыми.
 *
 * `heldScope` — область `with…(body)`, открытая на время `describe`. Шаги
 * прежнего теста Deno делили один ресурс внутри
 * `await withX(…, async (r) => { … })`; `it` Vitest исполняются уже после
 * сбора `describe`, поэтому область держится хуками: `beforeAll` входит в
 * неё и ждёт, `afterAll` отпускает и дожидается уборки самой `withX`.
 *
 * `fakeTimers` — поддельные часы до конца текущего `it` (прежний
 * `using time = new FakeTime()`).
 */

import { afterAll, beforeAll, onTestFinished, vi } from "vitest";

/**
 * Ресурс области; до `beforeAll` и после отказа входа — исключение.
 *
 * Хук области регистрируется первым: подготовка `describe`, объявленная
 * после вызова (`beforeAll(() => harness(db()))`), уже видит ресурс —
 * `beforeAll` Vitest идут в порядке объявления.
 */
export function heldScope<T>(
  enter: (body: (value: T) => Promise<void>) => Promise<void>,
): () => T {
  let current = (): T => {
    throw new Error("область теста не открыта");
  };
  const release = Promise.withResolvers<void>();
  let left: Promise<void> = Promise.resolve();
  beforeAll(async () => {
    const entered = Promise.withResolvers<void>();
    left = enter(async (value) => {
      current = () => value;
      entered.resolve();
      await release.promise;
    });
    await Promise.race([entered.promise, left]);
  });
  afterAll(async () => {
    release.resolve();
    await left;
  });
  return () => current();
}

/** Поддельные часы (`now` — их старт) до конца текущего `it`. */
export function fakeTimers(now?: number): void {
  vi.useFakeTimers(now === undefined ? undefined : { now });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}
