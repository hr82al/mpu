/**
 * Процесс `mpu-complete` (`specs/complete.md`, «CLI-контракт»;
 * `platform/reflection.md`, «mpu-complete»): `--version`, `init
 * <оболочка>`, дополнение строки — от `mpu-back`, а без него из снимка.
 * Дополнение не падает: нет ни того, ни другого — нет вариантов, код 0.
 */

import { VERSION } from "../../back/src/frames/mod.ts";
import { fromSnapshot, printed } from "./complete.ts";
import type { Choice } from "./tree.ts";
import { initScript, SHELL_NAMES, shellOf } from "./init.ts";

const DEFAULT_COMMAND = "mpu";

/** Что процессу нужно снаружи. */
export interface CompleteProcess {
  /** Снимок по умолчанию (`$HOME/.cache/mpu/tree.json`). */
  readonly snapshotPath: string;
  /** Текст файла; не читается — пустая строка. */
  readonly read: (path: string) => Promise<string>;
  /** Варианты строки от `mpu-back`; не ответил — `undefined`. */
  readonly back: (line: string) => Promise<readonly Choice[] | undefined>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

function init(args: readonly string[], proc: CompleteProcess): number {
  const shell = shellOf(args[0] ?? "");
  if (shell === undefined) {
    proc.stderr(
      `mpu-complete: оболочка ${
        args[0] ?? ""
      } не поддерживается (${SHELL_NAMES})\n`,
    );
    return 2;
  }
  const named = args[1] === "--command" && args[2] !== undefined;
  if (args.length !== 1 && !(named && args.length === 3)) {
    proc.stderr("mpu-complete: init <оболочка> [--command <имя>]\n");
    return 2;
  }
  proc.stdout(initScript(shell, named ? args[2] : DEFAULT_COMMAND));
  return 0;
}

/**
 * Исполняет `mpu-complete` и возвращает код.
 *
 * @param args аргументы процесса
 * @param proc окружение процесса
 */
export async function runComplete(
  args: readonly string[],
  proc: CompleteProcess,
): Promise<number> {
  if (args.length === 1 && args[0] === "--version") {
    proc.stdout(`${VERSION}\n`);
    return 0;
  }
  if (args[0] === "init") return init(args.slice(1), proc);
  const cut = args.indexOf("--");
  const options = cut < 0 ? args : args.slice(0, cut);
  const snapshot = options.length === 2 && options[0] === "--snapshot"
    ? options[1]
    : proc.snapshotPath;
  if (
    cut < 0 || (options.length !== 0 && options.length !== 2) ||
    (options.length === 2 && options[0] !== "--snapshot")
  ) {
    proc.stderr("mpu-complete: нужен -- и слова\n");
    return 2;
  }
  const words = args.slice(cut + 1);
  const fromBack = await proc.back(words.join(" "));
  proc.stdout(
    printed(fromBack ?? fromSnapshot(words, await proc.read(snapshot))),
  );
  return 0;
}
