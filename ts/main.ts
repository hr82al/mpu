/**
 * Точка входа `deno compile` → бинарь `mpu`: собирает зависимости и
 * передаёт argv точке входа CLI. Логика — в src/…; здесь только
 * склейка, чтобы всё остальное тестировалось без запуска бинаря.
 */

import { runCli } from "./src/entrypoint/mod.ts";
import {
  defaultConfigStorePath,
  makeDenoIo,
  makeDenoOutput,
} from "./src/runtime/mod.ts";

async function main(args: readonly string[]): Promise<number> {
  const output = makeDenoOutput();
  try {
    return await runCli(args, makeDenoIo(defaultConfigStorePath()), output);
  } catch (err) {
    // Необработанное падение команды: стандартное сообщение без сырого
    // трейса (контракт registry.md), детали — в cause-цепочке.
    const message = err instanceof Error ? err.message : String(err);
    output.stderr(`mpu: unexpected error: ${message}\n`);
    return 1;
  }
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
