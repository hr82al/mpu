/**
 * Тело комментария (`docs/specs/mr-write.md`, «CLI-контракт»): ровно
 * один источник — `-m/--message` либо `-F/--body-file`.
 *
 * Проверка идёт до первого сетевого запроса и до резолва `--mr`: у
 * пишущей команды «сначала сходили, потом отказали» означало бы
 * git-подпроцесс и обращение к GitLab ради вызова, который заведомо
 * неверен.
 *
 * Тело уходит дословно: ни trim, ни дописывания перевода строки. То,
 * что оператор набрал в редакторе или прислал через stdin, ревьюер
 * должен увидеть символ в символ.
 */

import { type CommandIo, UsageError } from "../command/mod.ts";

/** Срез порта: файл тела и stdin. */
export type BodyIo = Pick<CommandIo, "readTextFile" | "readStdin">;

/** Два флага тела; ровно один из них обязан быть задан. */
export interface BodyArgs {
  readonly message?: string | undefined;
  readonly "body-file"?: string | undefined;
}

/**
 * Тело из единственного источника. `required: false` — у `create`
 * описание необязательно: без обоих флагов оно пустое.
 */
export async function commentBody(
  args: BodyArgs,
  io: BodyIo,
  required = true,
): Promise<string> {
  const message = args.message;
  const file = args["body-file"];
  if (message !== undefined && file !== undefined) {
    throw new UsageError("нужно ровно одно из -m/--message и -F/--body-file");
  }
  if (message === undefined && file === undefined) {
    if (!required) return "";
    throw new UsageError("нужно ровно одно из -m/--message и -F/--body-file");
  }
  const body = message !== undefined
    ? message
    : await readBody(io, file as string);
  if (!required && body === "") return "";
  if (body.trim() === "") throw new UsageError("пустое тело комментария");
  return body;
}

/** Чтение файла тела; `-` — весь stdin (только в CLI). */
async function readBody(io: BodyIo, path: string): Promise<string> {
  if (path === "-") return new TextDecoder().decode(await io.readStdin());
  try {
    return await io.readTextFile(path);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new UsageError(`не удалось прочитать ${path}: ${detail}`, {
      cause: err,
    });
  }
}
