/**
 * Вызов инструмента глазами хука (`claude-hook-pre-tool-use.md`, «Ввод»):
 * либо слова строки `mpu` — решающему, либо готовый ответ.
 */

import type { HookReply } from "./reply.ts";

/** Решение по словам строки `mpu` (без самого `mpu`). */
export type Consult = (words: readonly string[]) => Promise<HookReply>;

/** Вызов инструмента: слова строки — решающему, прочее — свой ответ. */
export interface ToolCall {
  reply(consult: Consult): Promise<HookReply>;
}
