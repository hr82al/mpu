/**
 * Отражение, которому нечего сказать (`platform/reflection.md`): пустые
 * списки. Единственный null-объект отражения; протокол понимает любой
 * объект и без него.
 */

import type { Reflection } from "./protocol.ts";

/** Нет сообщений, ключей, форматов и значений. */
export const SILENT: Reflection = {
  messages: () => [],
  keys: () => [],
  formats: () => [],
  variants: () => [],
  candidates: () => Promise.resolve([]),
  understands: () => false,
  prompts: () => false,
};
