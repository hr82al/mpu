/**
 * Процесс CLI: собирает зависимости, ведёт запись журнала вызовов и
 * отдаёт argv точке входа. Точек входа две (`main.ts`, `next.ts`), и
 * журнал у них обязан писаться одинаково (`platform/invoke-log.md`,
 * `platform/registry-objects.md`) — поэтому склейка живёт здесь одна.
 */

import type { CommandIo } from "../command/mod.ts";
import type { InvokeJournal, Output } from "../entrypoint/mod.ts";
import { makeInvokeLog } from "../invokelog/mod.ts";
import {
  defaultCredsDir,
  defaultInvokeLogPath,
  defaultStateDir,
  makeDenoIo,
  makeDenoOutput,
} from "../runtime/mod.ts";

/** Точка входа: argv, окружение, вывод, журнал → код завершения. */
export type CliEntry = (
  args: readonly string[],
  io: CommandIo,
  output: Output,
  journal: InvokeJournal,
) => Promise<number>;

/**
 * Исполняет вызов процесса точкой входа `entry` и возвращает код
 * завершения.
 *
 * @param args argv процесса без имени программы
 * @param entry точка входа
 */
export async function runProcess(
  args: readonly string[],
  entry: CliEntry,
): Promise<number> {
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
    code = await entry(args, io, output, {
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
