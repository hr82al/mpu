/**
 * Точка входа `deno compile` → бинарь `mpu`: разбор аргумента верхнего
 * уровня и склейка зависимостей. Логика — в src/…; здесь временный
 * минимальный диспетчер одной команды: полный реестр появится по
 * спеке docs/specs/platform/registry.md.
 */

import {
  defaultConfigStorePath,
  makeDenoIo,
  runXlsx,
} from "./src/xlsx/mod.ts";

async function main(args: readonly string[]): Promise<number> {
  const io = makeDenoIo(defaultConfigStorePath());
  const [command, ...rest] = args;
  if (command === "xlsx") {
    try {
      return await runXlsx(rest, io);
    } catch (err) {
      // Необработанное падение команды: стандартное сообщение без
      // сырого трейса (контракт registry.md), детали — в cause-цепочке.
      const message = err instanceof Error ? err.message : String(err);
      io.stderr(`mpu xlsx: unexpected error: ${message}\n`);
      return 1;
    }
  }
  if (command === undefined || command === "-h" || command === "--help") {
    io.stdout("Использование: mpu xlsx …\n");
    // Явный запрос справки — успех; вызов без команды — ошибка
    // (registry.md: mpu --help ≡ mpu -h → exit 0, голый mpu → exit 2).
    return command === undefined ? 2 : 0;
  }
  io.stderr(`No such command '${command}'.\nTry 'mpu -h' for help.\n`);
  return 2;
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
