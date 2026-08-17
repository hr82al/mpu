/**
 * ssh-бэкенд транспорта (`platform/exec-transport.md`, «ssh-путь»):
 * локальный процесс `ssh`, которому удалённой командой отдан
 * `docker exec` в контейнер. Кода выхода бэкенд не трогает: ssh доносит
 * код удалённой команды, и он же становится кодом вызова (инвариант
 * «1:1 и никогда не схлопывается в 0»).
 *
 * Kill при Ctrl+C здесь не делается: разрыв ssh-сессии убивает
 * удалённый процесс сам (спека, «Граничные случаи»).
 */

import type { RemoteOutput } from "../command/mod.ts";
import { quoteArg, shellCommand } from "./shell.ts";
import type { ExecTarget } from "./target.ts";

/** Ssh-таргет: бэкенд другого не принимает. */
export type SshTarget = Extract<ExecTarget, { kind: "ssh" }>;

/**
 * Запуск локального процесса: аргументы, весь stdin байтами и приёмник
 * потоков. Порт на стороне потребителя — тесту достаточно подставить
 * функцию, а не подменять `Deno.Command`.
 */
export type RunProcess = (
  bin: string,
  args: readonly string[],
  stdin: Uint8Array,
  output: RemoteOutput,
) => Promise<number>;

/** Что нужно ssh-бэкенду для одного прогона. */
export interface SshRun {
  readonly target: SshTarget;
  readonly command: readonly [string, ...string[]];
  readonly stdin: Uint8Array;
  /** Путь ssh-ключа: `~` шелла здесь никто не раскроет. */
  readonly keyPath: string;
  readonly output: RemoteOutput;
  readonly run?: RunProcess;
}

/** Код выхода удалённой команды. */
export function runOverSsh(options: SshRun): Promise<number> {
  const run = options.run ?? spawnProcess;
  return run(
    "ssh",
    sshArgs(options.target, options.command, options.keyPath),
    options.stdin,
    options.output,
  );
}

/**
 * Аргументы `ssh`. Удалённая строка — один аргумент: ssh склеил бы
 * несколько через пробел, и квотирование, сделанное здесь, потерялось бы.
 */
export function sshArgs(
  target: SshTarget,
  command: readonly [string, ...string[]],
  keyPath: string,
): readonly string[] {
  const remote = `docker exec -i ${quoteArg(target.container)} sh -c ` +
    quoteArg(shellCommand(command));
  return ["-i", keyPath, `${target.user}@${target.host}`, remote];
}

/**
 * Настоящий подпроцесс. Подача stdin и чтение обоих потоков идут
 * одновременно: труба конечна, и запись целиком до первого чтения
 * встала бы намертво на команде, печатающей больше её размера.
 */
export const spawnProcess: RunProcess = async (bin, args, stdin, output) => {
  const child = new Deno.Command(bin, {
    args: [...args],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  try {
    await Promise.all([
      feed(child.stdin, stdin),
      pump(child.stdout, output.out),
      pump(child.stderr, output.err),
    ]);
  } catch (err) {
    // Отказ чтения потока оставляет процесс живым, а его промис статуса
    // — неразрешённым: без явного kill утекли бы и подпроцесс, и трубы.
    child.kill();
    await child.status;
    throw err;
  }
  return (await child.status).code;
};

/**
 * Подача stdin целиком и закрытие трубы: без EOF удалённая команда
 * ждала бы ввода вечно. Отказ записи не поднимается наверх — он значит,
 * что процесс уже закрыл свой stdin (вышел раньше или ввод ему не
 * нужен), и ответом на вызов остаётся его код выхода, а не жалоба на
 * трубу.
 */
async function feed(
  stream: WritableStream<Uint8Array>,
  bytes: Uint8Array,
): Promise<void> {
  const writer = stream.getWriter();
  try {
    await writer.write(bytes);
  } catch {
    // Закрытие сломанной трубы отвергается тем же отказом.
    await writer.close().catch(() => {});
    return;
  }
  await writer.close();
}

async function pump(
  stream: ReadableStream<Uint8Array>,
  write: (chunk: Uint8Array) => void,
): Promise<void> {
  for await (const chunk of stream) write(chunk);
}
