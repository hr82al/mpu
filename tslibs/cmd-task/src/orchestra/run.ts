/**
 * Цикл процесса `mpu-task` (`task-orchestrator.md`, «Процесс»): шаг по
 * всем проектам каждые 5 с до сигнала остановки.
 */

import type { Clock } from "./ports.ts";

/** Промежуток между шагами. */
export const STEP_MS = 5_000;

/** То, что цикл шагает. */
export interface Stepper {
  step(): Promise<void>;
}

/**
 * Шагает до `signal`. Сбой шага целиком (база недоступна) — строка лога,
 * цикл продолжается: служба не должна падать от занятой базы.
 */
export async function runSteps(
  stepper: Stepper,
  signal: AbortSignal,
  log: (text: string) => void,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await stepper.step();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`шаг: ${reason}`);
    }
    await pause(STEP_MS, signal);
  }
}

/**
 * Пауза `ms`; `signal` кончает её раньше. Уже поднятый сигнал — пауза
 * кончена сразу: событие `abort` второй раз не придёт.
 */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Часы процесса. */
export const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms) => pause(ms),
};
