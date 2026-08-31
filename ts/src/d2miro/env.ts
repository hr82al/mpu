/**
 * Внешние зависимости команды `d2-miro`, которых нет в `CommandIo`:
 * время файла рядом со входом, запуск `d2` и сеть.
 *
 * Порт объявлен здесь, у потребителя, а не добавлен в общий
 * `CommandIo`: он нужен одной команде, и расширять им интерфейс,
 * который реализуют все фейки, значило бы платить за него везде.
 * Приём тот же, что у запуска ssh (`src/exec/ssh.ts`): подменяется
 * функция, а не `Deno.Command`.
 */

import type { FetchLike } from "./miro.ts";

/** Внешний мир глазами команды. */
export interface D2MiroEnv {
  /** Время правки файла в мс; файла нет — `undefined`. */
  readonly mtime: (path: string) => Promise<number | undefined>;
  /** Есть ли `d2` в PATH. */
  readonly hasD2: () => Promise<boolean>;
  /** Запуск `d2 <вход> <выход>`; код возврата и stderr подпроцесса. */
  readonly renderSvg: (
    input: string,
    output: string,
  ) => Promise<{ code: number; stderr: string }>;
  readonly fetch: FetchLike;
  readonly sleep: (ms: number) => Promise<void>;
}

/** Реальные зависимости поверх API Deno. */
export function denoD2MiroEnv(): D2MiroEnv {
  return {
    mtime: async (path) => {
      try {
        return (await Deno.stat(path)).mtime?.getTime();
      } catch {
        // Отсутствие файла и любая другая причина «времени нет» для
        // правил выбора SVG — одно и то же: рендерить заново.
        return undefined;
      }
    },
    hasD2: async () => await run("d2", ["--version"]) !== undefined,
    renderSvg: async (input, output) => {
      const outcome = await run("d2", [input, output]);
      return outcome ?? { code: 127, stderr: "d2 CLI is not in PATH" };
    },
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** Запуск подпроцесса; бинаря нет — `undefined`, а не отказ. */
async function run(
  bin: string,
  args: readonly string[],
): Promise<{ code: number; stderr: string } | undefined> {
  try {
    const output = await new Deno.Command(bin, {
      args: [...args],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: output.code,
      stderr: new TextDecoder().decode(output.stderr),
    };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
}
