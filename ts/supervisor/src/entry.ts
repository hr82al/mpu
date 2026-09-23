/**
 * Процесс `mpu-supervisor` (`platform/supervisor-install.md`): флаги,
 * `--version`, сигналы → действия над дочерними.
 */

import type { Child, Clock, Launcher, Log } from "./child.ts";
import { Supervisor } from "./supervisor.ts";
import type { WatchSetup } from "./watchdog.ts";

/**
 * Версия сборки. Соседей супервизор не импортирует, поэтому это литерал;
 * с `back/src/version.ts` его сверяет `supervisor/src/tasks_test.ts`.
 */
export const VERSION = "0.1.0";

const USAGE =
  "mpu-supervisor: использование: mpu-supervisor --back <путь> --mcp <путь>\n";

/** Сигналы, на которые отвечает супервизор. */
export type SupervisorSignal = "SIGUSR1" | "SIGUSR2" | "SIGTERM" | "SIGINT";

/** Что процессу нужно снаружи. */
export interface SupervisorProcess {
  readonly launcher: Launcher;
  readonly clock: Clock;
  readonly log: Log;
  readonly stdout: (text: string) => void;
  /** Сторож памяти исполнителей (`platform/line-executor.md`). */
  readonly watch: WatchSetup;
  /** Подписка на сигналы процесса. */
  readonly onSignal: (
    signal: SupervisorSignal,
    handler: () => void,
  ) => void;
}

/** Пути дочерних из флагов; не разобрались — `undefined`. */
function pathsOf(
  args: readonly string[],
): { back: string; mcp: string } | undefined {
  const flags = new Map<string, string>();
  for (let i = 0; i + 1 < args.length; i += 2) flags.set(args[i], args[i + 1]);
  const back = flags.get("--back");
  const mcp = flags.get("--mcp");
  if (args.length !== 4 || back === undefined || mcp === undefined) {
    return undefined;
  }
  return { back, mcp };
}

/**
 * Исполняет процесс супервизора и возвращает код завершения.
 *
 * @param args аргументы процесса
 * @param proc окружение процесса
 */
export async function runSupervisor(
  args: readonly string[],
  proc: SupervisorProcess,
): Promise<number> {
  if (args.length === 1 && args[0] === "--version") {
    proc.stdout(`${VERSION}\n`);
    return 0;
  }
  const paths = pathsOf(args);
  if (paths === undefined) {
    proc.log.err(USAGE.trimEnd());
    return 2;
  }
  const supervisor = new Supervisor({ ...paths, ...proc });
  const stopped = Promise.withResolvers<void>();
  // Сигнал → действие над конкретным дочерним: таблица на границе.
  // Обработчик сигнала результата не ждёт: перезапуск идёт сам, его
  // сбой — строка в stderr, а не потерянный отказ.
  const restart = (child: Child) => () => {
    child.restart().catch((err) =>
      proc.log.err(`[supervisor] перезапуск не удался: ${String(err)}`)
    );
  };
  const actions: readonly (readonly [SupervisorSignal, () => void])[] = [
    ["SIGUSR1", restart(supervisor.back)],
    ["SIGUSR2", restart(supervisor.mcp)],
    ["SIGTERM", () => stopped.resolve()],
    ["SIGINT", () => stopped.resolve()],
  ];
  for (const [signal, action] of actions) proc.onSignal(signal, action);
  supervisor.start();
  await stopped.promise;
  await supervisor.stop();
  return 0;
}
