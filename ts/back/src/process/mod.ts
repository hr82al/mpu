/**
 * Процесс CLI: собирает зависимости, ведёт запись журнала вызовов и
 * отдаёт argv точке входа. Точек входа две (`main.ts`, `next.ts`), и
 * журнал у них обязан писаться одинаково (`platform/invoke-log.md`,
 * `platform/registry-objects.md`) — поэтому склейка живёт здесь одна.
 */

import type { CommandIo } from "../command/mod.ts";
import type { InvokeJournal, Output } from "../entrypoint/mod.ts";
import {
  type InvokeLog,
  type InvokeRecording,
  makeInvokeLog,
  NO_INVOKE_LOG,
} from "../invokelog/mod.ts";
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
  const io = processIo();
  return await runJournaled(args, entry, io, processLog(io), makeDenoOutput());
}

/** Окружение процесса: каталоги состояния и конфигурации из окружения. */
export function processIo(): CommandIo {
  // Каталога два, и разводит их только эта строка: состояние — по
  // `HOME`, конфигурация — по `XDG_CONFIG_HOME` (правило названо в
  // справке верхнего уровня и в `defaultStateDir`).
  return makeDenoIo(defaultStateDir(), defaultCredsDir());
}

/** Журнал вызовов процесса. */
export function processLog(io: CommandIo): InvokeLog {
  return makeInvokeLog({
    // Настройки журнала — ключи `MPU_LOG_*` env-файла; окружение
    // процесса слой не читает (`platform/env-file.md`).
    env: io.envFile,
    defaultFile: defaultInvokeLogPath(),
    pid: Deno.pid,
    now: () => new Date(),
  });
}

/**
 * Начало записи: в ней каталог того, кто позвал, — у процесса CLI свой,
 * у строки сервера её (`platform/line-concurrency.md`).
 *
 * Каталог процесса читается у ОС и бросает, если его удалили; отказ
 * журнала не меняет ни результат команды, ни её код
 * (`platform/invoke-log.md`, «Инварианты»), поэтому такой вызов
 * записывается пустым журналом — то есть не записывается вовсе.
 */
function beginRecord(
  log: InvokeLog,
  args: readonly string[],
  io: Pick<CommandIo, "cwd">,
): InvokeRecording {
  let cwd: string;
  try {
    cwd = io.cwd();
  } catch {
    // Причина не важна и сообщать её некуда: вывод принадлежит команде.
    return NO_INVOKE_LOG.begin({ kind: "argv", argv: args, cwd: "" });
  }
  return log.begin({ kind: "argv", argv: args, cwd });
}

/**
 * Одна строка с записью журнала: отметка старта, перехват вывода,
 * исполнение точкой входа, итог. Процесс CLI исполняет одну строку,
 * сервер строк — по записи на каждую.
 *
 * @param args слова строки
 * @param entry точка входа
 * @param io окружение команды
 * @param log журнал вызовов
 * @param streams куда идёт вывод строки
 */
export async function runJournaled(
  args: readonly string[],
  entry: CliEntry,
  io: CommandIo,
  log: InvokeLog,
  streams: Output,
): Promise<number> {
  // Запись начинается до маршрутизации: она фиксирует время старта, а
  // писаться будет только у вызова маршрута `native` — отметку ставит
  // точка входа (`platform/invoke-log.md`).
  const record = beginRecord(log, args, io);
  const output = record.capture(streams);
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
