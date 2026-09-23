/**
 * Порт строки поверх порта процесса (`platform/call-context.md`,
 * `platform/line-concurrency.md`): ввод, терминальность и переменные —
 * из того, что принёс вызывающий; каталог — собственный каталог строки;
 * остальное — окружение процесса. Собирают его одинаково ядро и
 * исполнитель строки (`platform/line-executor.md`): своих дескрипторов и
 * своего каталога ни тот, ни другой не подставляет.
 */

import type { CommandIo } from "../command/mod.ts";
import type { CallContext } from "../frames/mod.ts";
import { Workdir } from "../workdir/mod.ts";

/**
 * Порт строки с контекстом `context` в каталоге `cwd`.
 *
 * @param io порт процесса
 * @param context что принёс вызывающий
 * @param cwd каталог строки
 */
export function callIo(
  io: CommandIo,
  context: CallContext,
  cwd: string,
): CommandIo {
  const environment = context.env.over(io.env);
  const terminals = context.terminals;
  const dir = new Workdir(cwd);
  return {
    ...io,
    env: (name) => environment.value(name),
    cwd: () => dir.path(),
    // Пути файлов — от каталога строки: `Deno.*` разрешает
    // относительный путь от процесса, а он больше не переезжает в
    // каталог строки.
    readFile: (path) => io.readFile(dir.resolve(path)),
    readRegularFile: (path) => io.readRegularFile(dir.resolve(path)),
    readTextFile: (path) => io.readTextFile(dir.resolve(path)),
    appendFile: (path, text) => io.appendFile(dir.resolve(path), text),
    // `launchOpener` не трогаем: его цель — не обязательно путь
    // (`sheet open` отдаёт ссылку), а путь `xlsx open` резолвит сам
    // через `io.cwd()` — то есть уже от каталога строки.
    readStdin: () => context.input.bytes(),
    stdinIsTerminal: () => terminals.stdin(),
    stdoutIsTerminal: () => terminals.stdout(),
    stderrIsTerminal: () => terminals.stderr(),
    consoleColumns: () => terminals.columns(),
  };
}
