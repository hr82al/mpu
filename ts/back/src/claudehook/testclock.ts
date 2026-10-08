/**
 * Часы тестов столов вопросов: паузы кончает сам тест, реального сна нет
 * (`ts/CLAUDE.md`, «TDD»).
 */

import type { Clock } from "@mpu/cmd-botquestions";

/** Часы, которые ведёт тест: пауза кончается его `fire`. */
export class TestClock implements Clock {
  readonly #pending: { ms: number; resolve: () => void }[] = [];
  readonly #waiters: { ms: number; resolve: () => void }[] = [];
  /** Длительности всех пауз по порядку. */
  readonly asked: number[] = [];

  now(): number {
    return 0;
  }

  pause(ms: number, signal: AbortSignal): Promise<void> {
    this.asked.push(ms);
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const entry = { ms, resolve };
      this.#pending.push(entry);
      signal.addEventListener(
        "abort",
        () => {
          this.#pending.splice(this.#pending.indexOf(entry), 1);
          reject(signal.reason);
        },
        { once: true },
      );
      for (const waiter of this.#waiters.filter((w) => w.ms === ms)) {
        waiter.resolve();
      }
    });
  }

  /** Ждёт, пока кто-то встанет на паузу `ms`. */
  paused(ms: number): Promise<void> {
    if (this.#pending.some((entry) => entry.ms === ms)) {
      return Promise.resolve();
    }
    const waiter = Promise.withResolvers<void>();
    this.#waiters.push({ ms, resolve: waiter.resolve });
    return waiter.promise;
  }

  /** Кончает паузы `ms`. */
  fire(ms: number): void {
    for (const entry of this.#pending.filter((e) => e.ms === ms)) {
      this.#pending.splice(this.#pending.indexOf(entry), 1);
      entry.resolve();
    }
  }
}
