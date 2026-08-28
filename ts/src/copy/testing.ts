/**
 * Вызов `mpu copy-client` из тестов. Единственное его отличие от
 * настоящего — `runRedis` объявлен **обязательным**.
 *
 * Причина в том, как устроен сам шов: у него есть умолчание, настоящий
 * `docker exec`, и тест, забывший подставить своё, полез бы в docker на
 * машине прогона. Красным это не станет — отказ обоих redis-шагов
 * гасится в предупреждение по построению, — то есть дисциплиной такой
 * пропуск не ловится. Обязательность выражена типом: пропуск не
 * проходит `deno check`.
 *
 * Лежит рядом с командой, а не в файле тестов: гарантия нужна всем
 * будущим тестам, а не одному файлу, который её у себя завёл.
 *
 * Файл подключают только тесты: в бинарь он не попадает, потому что из
 * `main.ts` недостижим (тот же приём, что у `../gitlab/testing.ts`).
 */

import {
  type CopyIo,
  type CopyOptions,
  runCopyClient,
} from "./cmd_copy_client.ts";
import type { RunRedis } from "./tools.ts";

/** Опции теста: шов redis подставляется явно и всегда. */
export type TestCopyOptions = CopyOptions & { readonly runRedis: RunRedis };

/** Redis, к которому обращаться нечем: молча принимает и ничего не делает. */
export const noRedis: RunRedis = () => Promise.resolve();

export function copyClientInTest(
  args: { readonly selector: string },
  io: CopyIo,
  options: TestCopyOptions,
) {
  return runCopyClient(args, io, options);
}
