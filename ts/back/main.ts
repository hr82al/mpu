/**
 * Точка входа `deno compile` → бинарь `mpu`: собирает зависимости и
 * передаёт argv точке входа CLI. Логика — в src/…; здесь только
 * склейка, чтобы всё остальное тестировалось без запуска бинаря.
 */

import { runCli } from "./src/entrypoint/mod.ts";
import { makeInvokeLog } from "./src/invokelog/mod.ts";
import {
  defaultCredsDir,
  defaultInvokeLogPath,
  defaultStateDir,
  makeDenoIo,
  makeDenoOutput,
} from "./src/runtime/mod.ts";

async function main(args: readonly string[]): Promise<number> {
  // Каталога два, и разводит их только эта строка: состояние — по
  // `HOME`, конфигурация — по `XDG_CONFIG_HOME` (правило названо в
  // справке верхнего уровня и в `defaultStateDir`).
  const io = makeDenoIo(defaultStateDir(), defaultCredsDir());
  const log = makeInvokeLog({
    // Настройки журнала — ключи `MPU_LOG_*` env-файла; окружение
    // процесса слой не читает (`platform/env-file.md`).
    env: io.envFile,
    defaultFile: defaultInvokeLogPath(),
    pid: Deno.pid,
    cwd: () => Deno.cwd(),
    now: () => new Date(),
  });
  // Запись начинается до маршрутизации: она фиксирует время старта, а
  // писаться будет только у вызова маршрута `native` — отметку ставит
  // точка входа (`platform/invoke-log.md`).
  const record = log.begin({ kind: "argv", argv: args });
  const output = record.capture(makeDenoOutput());
  let code: number;
  try {
    code = await runCli(args, io, output, {
      nativeCall: (command) => record.nativeCall(command),
      note: (line) => record.note(line),
      log,
    });
  } catch (err) {
    // Необработанное падение команды: стандартное сообщение без сырого
    // трейса (контракт registry.md), детали — в cause-цепочке. Печать
    // идёт в перехваченный вывод, поэтому причина попадает и в запись.
    const message = err instanceof Error ? err.message : String(err);
    output.stderr(`mpu: unexpected error: ${message}\n`);
    code = 1;
  }
  await record.finish(code);
  return code;
}

if (import.meta.main) {
  Deno.exit(await main(Deno.args));
}
