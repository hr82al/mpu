/**
 * Разбор ввода `mpu telegram send` в план отправки
 * (`docs/specs/telegram-send.md`): адресат, текст, вложения.
 *
 * Весь ввод разбирается здесь и до сети: отбитый вызов не стоит ни
 * одного сетевого обращения, поэтому модуль ничего не знает о сеансе.
 */

import { type CommandIo, readTextStdin } from "../command/mod.ts";
import { type Attachment, readAttachment } from "./attachment.ts";
import { inputError } from "./errors.ts";
import { EMPTY_TARGET, parsePeer } from "./peer.ts";
import type { SendPlan } from "./send.ts";

/** Аргументы вызова после разбора схемой. */
export interface SendArgs {
  readonly message: string;
  readonly chat?: string;
  readonly md: boolean;
  readonly file: readonly string[];
}

/** Что плану нужно от порта: вложения обычными файлами и stdin. */
export type PlanIo = Pick<CommandIo, "readRegularFile" | "readStdin">;

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
  if (target === "") throw inputError(EMPTY_TARGET);
  const raw = args.message === "-" ? await readTextStdin(io) : args.message;
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
  for (const path of paths) files.push(await readAttachment(io, path));
  return files;
}
