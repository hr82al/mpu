/**
 * Общее у команд `mpu task`: журнал на время вызова, глубина из конфига,
 * тело из `text:`/`file:` и перевод отказов канала в классы контракта
 * команды.
 */

import { z } from "@zod/zod";
import { type CommandIo, DomainError, UsageError } from "../command/mod.ts";
import { configValue, TASK_HISTORY } from "../config/mod.ts";
import { UnknownKind } from "./kind.ts";
import {
  type Depth,
  KEEP_ALL,
  Keeping,
  Projects,
  TaskRefusal,
  TaskUsage,
} from "./project.ts";

/** Ключ `project:` команд, которым нужен один проект. */
export const PROJECT = z.string({ error: "нужен project: <имя>" }).describe(
  "имя проекта канала",
);

/** Порт, которым команды канала ходят наружу. */
export type TaskIo = Pick<
  CommandIo,
  "openCacheDb" | "readTextFile" | "note" | "signal"
>;

/** Что команда делает с журналом. */
export type Act<T> = (projects: Projects, depth: Depth) => T;

/**
 * Журнал на время `act`: соединение закрывается сразу после, отказы
 * канала становятся ошибками контракта (ввод — код 2, состояние — 1).
 */
export function withJournal<T>(io: TaskIo, act: Act<T>): T {
  using db = io.openCacheDb();
  const projects = Projects.open(db);
  const depth = depthOf(configValue(db, TASK_HISTORY.key), io);
  try {
    return act(projects, depth);
  } catch (err) {
    throw contractError(err);
  }
}

/** Отказ канала — класс контракта; прочее — как есть. */
export function contractError(err: unknown): unknown {
  if (err instanceof TaskUsage || err instanceof UnknownKind) {
    return new UsageError(err.message, { cause: err });
  }
  if (err instanceof TaskRefusal) {
    return new DomainError(err.message, { cause: err });
  }
  return err;
}

/**
 * Глубина журнала из значения ключа `task.history`; не целое — умолчание
 * ключа и заметка в журнал вызова.
 */
function depthOf(value: string | undefined, io: Pick<TaskIo, "note">): Depth {
  const fallback = Number(TASK_HISTORY.fallback(undefined));
  const set = value ?? String(fallback);
  const portions = /^-?\d+$/.test(set) ? Number(set) : undefined;
  if (portions === undefined) {
    io.note(`task.history: не целое ${JSON.stringify(set)}, взято ${fallback}`);
  }
  const depth = portions ?? fallback;
  return depth < 0 ? KEEP_ALL : new Keeping(depth);
}

/** Тело сообщения: `text:` или `file:`, ровно одно из двух, не пустое. */
export async function bodyOf(
  args: { readonly text?: string; readonly file?: string },
  io: Pick<TaskIo, "readTextFile">,
): Promise<string> {
  if (args.text !== undefined && args.file !== undefined) {
    throw new UsageError("тело — text: или file:, не оба");
  }
  const body = args.file === undefined
    ? args.text
    : await fileBody(args.file, io);
  if (body === undefined) throw new UsageError("нет тела — text: или file:");
  if (body.trim() === "") throw new UsageError("пустое тело сообщения");
  return body;
}

async function fileBody(
  path: string,
  io: Pick<TaskIo, "readTextFile">,
): Promise<string> {
  try {
    return await io.readTextFile(path);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new UsageError(`не удалось прочитать ${path}: ${reason}`, {
      cause: err,
    });
  }
}
