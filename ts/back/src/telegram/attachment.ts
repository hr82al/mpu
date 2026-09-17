/**
 * Файл, прикладываемый к сообщению: чтение с диска и имя, под которым он
 * уйдёт в Telegram. Модуль общий на два канала — личный аккаунт
 * (`mpu telegram send`, MTProto) и личного бота (`mpu telegram log`,
 * Bot API): протоколы разные, а ввод один, и тексты отказов у него
 * обязаны совпадать.
 *
 * Чтение — до сети: отбитый вызов не стоит ни одного обращения наружу.
 */

import { type CommandIo, NotFoundIoError, UsageError } from "../command/mod.ts";

/** Файл, уходящий документом без превью; несколько — альбом. */
export interface Attachment {
  /** Имя файла в Telegram: файлы уходят под своими именами. */
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Что чтению нужно от порта: вложения — обычные файлы. */
export type AttachmentIo = Pick<CommandIo, "readRegularFile">;

/** Читает вложение; имя в Telegram — базовое имя пути. */
export async function readAttachment(
  io: AttachmentIo,
  path: string,
): Promise<Attachment> {
  return { name: baseName(path), bytes: await readBytes(io, path) };
}

async function readBytes(
  io: AttachmentIo,
  path: string,
): Promise<Uint8Array> {
  try {
    return await io.readRegularFile(path);
  } catch (err) {
    // Отказ разбора аргументов: своя рамка ошибок парсинга флагов, без
    // префикса слоя (`telegram-send.md`, «Известные отклонения»).
    if (err instanceof NotFoundIoError) {
      throw new UsageError(`файл-вложение не найден: ${path}`, { cause: err });
    }
    throw new UsageError(
      `не удалось прочитать вложение ${path}: ${reason(err)}`,
      { cause: err },
    );
  }
}

/** Базовое имя пути: файлы уходят под своими именами. */
function baseName(path: string): string {
  const tail = path.split("/").at(-1) ?? path;
  return tail === "" ? path : tail;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
