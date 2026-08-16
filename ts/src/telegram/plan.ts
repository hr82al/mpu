/**
 * Разбор ввода `mpu telegram send` в план отправки
 * (`docs/specs/telegram-send.md`): адресат, текст, вложения.
 *
 * Весь ввод разбирается здесь и до сети: отбитый вызов не стоит ни
 * одного сетевого обращения, поэтому модуль ничего не знает о сеансе.
 */

import { type CommandIo, NotFoundIoError, UsageError } from "../command/mod.ts";
import { inputError } from "./errors.ts";
import { parsePeer } from "./peer.ts";
import type { Attachment } from "./client.ts";
import type { SendPlan } from "./send.ts";

/** Аргументы вызова после разбора схемой. */
export interface SendArgs {
  readonly message: string;
  readonly chat?: string;
  readonly md: boolean;
  readonly file: readonly string[];
}

/** Что плану нужно от порта: вложения обычными файлами и stdin. */
export type PlanIo = Pick<CommandIo, "readRegularFile" | "readTextStdin">;

/**
 * Строит план вызова. Порядок отказов — от самого раннего: вложения
 * читаются первыми (их отбивает разбор аргументов), затем адресат, затем
 * текст.
 */
export async function sendPlan(
  args: SendArgs,
  io: PlanIo,
  defaultChat: string | undefined,
): Promise<SendPlan> {
  const attachments = await readAttachments(io, args.file);
  const target = args.chat ?? defaultChat ?? "";
  if (target === "") {
    throw inputError(
      "адресат не задан; укажи --chat или TELEGRAM_DEFAULT_CHAT в .env",
    );
  }
  const raw = args.message === "-" ? await io.readTextStdin() : args.message;
  // Пустой текст без вложений — ошибка, а не отправка пустого сообщения;
  // с вложением он означает документ без подписи. Пустой — и текст из
  // одних пробелов: подписью он быть не может, а раз так, то и уходить
  // в Telegram ему незачем.
  const text = raw.trim() === "" ? "" : raw;
  if (text === "" && attachments.length === 0) {
    throw inputError("пустой текст сообщения");
  }
  return {
    target,
    peer: parsePeer(target),
    text,
    markdown: args.md,
    attachments,
  };
}

/** Вложения в порядке флагов `-f`; имя в Telegram — базовое имя пути. */
async function readAttachments(
  io: PlanIo,
  paths: readonly string[],
): Promise<readonly Attachment[]> {
  const files: Attachment[] = [];
  for (const path of paths) {
    files.push({ name: baseName(path), bytes: await readAttachment(io, path) });
  }
  return files;
}

async function readAttachment(
  io: PlanIo,
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
