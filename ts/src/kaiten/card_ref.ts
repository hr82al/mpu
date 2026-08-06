/**
 * Селектор карточки (`docs/specs/platform/kaiten-http.md`, раздел
 * «Селектор карточки»): единый разбор аргумента-карточки во всех
 * командах `kiten-*`. В сеть не ходит — это инвариант атома, поэтому
 * разбор живёт отдельным файлом от транспорта.
 */

import { UsageError } from "../command/mod.ts";

/** Строка целиком из цифр — id карточки как есть. */
const BARE_ID = /^\d+$/;

/**
 * Id карточки из голого числа либо из URL: id — последний полностью
 * числовой сегмент пути (`…/space/286794/boards/card/65634936` →
 * 65634936, не 286794), query и fragment отбрасываются. Ни того, ни
 * другого нет — ошибка ввода (exit 2).
 */
export function parseCardRef(ref: string): number {
  if (BARE_ID.test(ref)) return Number(ref);

  const segments = pathSegments(ref);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (BARE_ID.test(segments[i])) return Number(segments[i]);
  }
  throw new UsageError(`не удалось извлечь id карточки из '${ref}'`);
}

/**
 * Сегменты пути URL; строка, не разбирающаяся как URL, даёт пустой
 * список — для неё числового сегмента заведомо нет.
 */
function pathSegments(ref: string): readonly string[] {
  let url;
  try {
    url = new URL(ref);
  } catch {
    // Не URL — не отдельный класс ошибки: спека знает один отказ на оба
    // случая, «не удалось извлечь id».
    return [];
  }
  return url.pathname.split("/");
}
