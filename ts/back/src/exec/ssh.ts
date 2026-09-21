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
 * Что подать подпроцессу, куда деть его вывод и где его запустить.
 * Каталог передаётся явно: подпроцесс наследует каталог процесса, а у
 * сервера строк он больше не переезжает в каталог строки
 * (`platform/line-concurrency.md`).
 */
export interface ProcessRun {
  /** Весь stdin подпроцесса байтами. */
  readonly stdin: Uint8Array;
  readonly output: RemoteOutput;
  /** Каталог старта подпроцесса — каталог своей строки. */
  readonly cwd: string;
  /**
   * Просьба остановиться: по ней подпроцессу уходит `SIGTERM`
   * (`platform/line-cancel.md`). Не сказано — остановки не бывает.
   */
  readonly signal?: AbortSignal;
  /**
   * Сколько ждать после `SIGTERM`, прежде чем слать `SIGKILL`; не
   * сказано — `KILL_AFTER_MS`.
   */
  readonly killAfterMs?: number;
}

/** Сколько подпроцессу дают на то, чтобы уйти самому. */
export const KILL_AFTER_MS = 5_000;

/**
 * Запуск локального процесса: бинарь, аргументы и подача с приёмником.
 * Порт на стороне потребителя — тесту достаточно подставить функцию, а
 * не подменять `Deno.Command`.
 */
export type RunProcess = (
  bin: string,
  args: readonly string[],
  proc: ProcessRun,
) => Promise<number>;

/** Что нужно ssh-бэкенду для одного прогона. */
export interface SshRun {
  readonly target: SshTarget;
  readonly command: readonly [string, ...string[]];
  readonly stdin: Uint8Array;
  /** Путь ssh-ключа: `~` шелла здесь никто не раскроет. */
  readonly keyPath: string;
  readonly output: RemoteOutput;
  /** Каталог вызывающего: в нём стартует локальный `ssh`. */
  readonly cwd: string;
  /** Просьба остановиться: по ней подпроцесс снимается. */
  readonly signal?: AbortSignal;
  readonly run?: RunProcess;
}

/** Код выхода удалённой команды. */
export function runOverSsh(options: SshRun): Promise<number> {
  const run = options.run ?? spawnProcess;
  return run(
    "ssh",
    sshArgs(options.target, options.command, options.keyPath),
    {
      stdin: options.stdin,
      output: options.output,
      cwd: options.cwd,
      signal: options.signal,
    },
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
  return sshArgsOf(
    target,
    keyPath,
    `docker exec -i ${quoteArg(target.container)} sh -c ` +
      quoteArg(shellCommand(command)),
  );
}

/** Те же аргументы для готовой удалённой строки (фоновый запуск). */
export function sshArgsOf(
  target: SshTarget,
  keyPath: string,
  remote: string,
): readonly string[] {
  return ["-i", keyPath, `${target.user}@${target.host}`, remote];
}

/**
 * Фоновый запуск по ssh (`platform/exec-transport.md`, «Фоновый
 * запуск»): сперва скрипт заливается в контейнер через stdin, затем
 * `docker exec -d` стартует node и возвращается сразу. Ненулевой код
 * заливки прерывает запуск — стартовать нечего.
 */
export async function detachOverSsh(options: {
  readonly target: SshTarget;
  readonly script: string;
  readonly scriptPath: string;
  readonly logPath: string;
  readonly keyPath: string;
  readonly output: RemoteOutput;
  /** Каталог вызывающего: в нём стартует локальный `ssh`. */
  readonly cwd: string;
  /** Просьба остановиться: по ней подпроцесс снимается. */
  readonly signal?: AbortSignal;
  readonly run?: RunProcess;
}): Promise<number> {
  const run = options.run ?? spawnProcess;
  const container = quoteArg(options.target.container);
  const upload = await run(
    "ssh",
    sshArgsOf(
      options.target,
      options.keyPath,
      `docker exec -i ${container} sh -c ` +
        quoteArg(`cat > ${options.scriptPath}`),
    ),
    {
      stdin: new TextEncoder().encode(options.script),
      output: options.output,
      cwd: options.cwd,
      signal: options.signal,
    },
  );
  if (upload !== 0) return upload;
  return await run(
    "ssh",
    sshArgsOf(
      options.target,
      options.keyPath,
      `docker exec -d ${container} sh -c ` +
        quoteArg(
          `node ${options.scriptPath} > ${options.logPath} 2>&1 < /dev/null`,
        ),
    ),
    {
      stdin: new Uint8Array(),
      output: options.output,
      cwd: options.cwd,
      signal: options.signal,
    },
  );
}

/**
 * Настоящий подпроцесс. Подача stdin и чтение обоих потоков идут
 * одновременно: труба конечна, и запись целиком до первого чтения
 * встала бы намертво на команде, печатающей больше её размера.
 *
 * Просьбу остановиться подпроцесс получает `SIGTERM`; не ушёл за
 * отведённый срок — `SIGKILL` (`platform/line-cancel.md`). Своего
 * подпроцесса не оставляет ни один из исходов: дождаться `status`
 * обязаны все.
 */
export const spawnProcess: RunProcess = async (bin, args, proc) => {
  const child = new Deno.Command(bin, {
    args: [...args],
    cwd: proc.cwd,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  using leaving = asksToLeave(child, proc);
  try {
    await Promise.all([
      feed(child.stdin, proc.stdin),
      pump(child.stdout, proc.output.out),
      pump(child.stderr, proc.output.err),
    ]);
  } catch (err) {
    // Отказ чтения потока оставляет процесс живым, а его промис статуса
    // — неразрешённым: без явного kill утекли бы и подпроцесс, и трубы.
    leaving.now();
    await child.status;
    throw err;
  }
  return (await child.status).code;
};

/** Чем подпроцесс снимают и как отписаться, когда он ушёл сам. */
interface Leaving extends Disposable {
  /** Снять немедленно, не дожидаясь просьбы. */
  now(): void;
}

/**
 * Подписка на просьбу остановиться: `SIGTERM` сразу, `SIGKILL` через
 * срок. Таймер и подписка снимаются, когда подпроцесс кончился, —
 * иначе у долгой строки копились бы и то и другое.
 */
function asksToLeave(child: Deno.ChildProcess, proc: ProcessRun): Leaving {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: Deno.Signal) => {
    try {
      child.kill(signal);
    } catch {
      // Подпроцесс уже кончился: снимать нечего, и это не отказ.
    }
  };
  const leave = () => {
    kill("SIGTERM");
    // Срок — параметр: тест не ждёт пять секунд, а называет свой.
    timer = setTimeout(
      () => kill("SIGKILL"),
      proc.killAfterMs ?? KILL_AFTER_MS,
    );
  };
  // Уже взведённый сигнал подписка не увидит — событие случилось
  // раньше неё (то же, что у паузы слежения, `logs/sources.ts`).
  // Подпроцесс, запущенный после просьбы остановиться, иначе дожил бы
  // до конца: строка уже отменена, а он работает.
  if (proc.signal?.aborted) leave();
  else proc.signal?.addEventListener("abort", leave, { once: true });
  return {
    now: leave,
    [Symbol.dispose]: () => {
      if (timer !== undefined) clearTimeout(timer);
      proc.signal?.removeEventListener("abort", leave);
    },
  };
}

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
  write: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  // Каждый кусок — до готовности приёмника: пока клиент не разобрал
  // отданное, мы не читаем следующий, и труба ребёнка притормаживает
  // его саму (`platform/line-cancel.md`).
  for await (const chunk of stream) await write(chunk);
}
