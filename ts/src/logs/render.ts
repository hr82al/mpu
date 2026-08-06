/**
 * Порядок и форма печати записей (`docs/specs/logs.md`, «Ввод/вывод»):
 * вывод всегда хронологический по возрастанию времени записи —
 * независимо от того, с какого конца окна их отдал источник, — а строка
 * печатается как есть, без хвостового перевода строки записи и без
 * вмешательства в управляющие последовательности цвета сервиса.
 */

import type { LogEntry } from "../loki/mod.ts";

/**
 * Копия записей по возрастанию времени. Направление запроса выбирает,
 * какой конец окна отдаст источник при усечении лимитом, но не порядок
 * печати — поэтому сортировка безусловна.
 */
export function byTimeAscending(
  entries: readonly LogEntry[],
): readonly LogEntry[] {
  // Наносекунды не влезают в `number` (около 1.7e18 против предела
  // 9e15), поэтому сравнение — на BigInt: иначе соседние записи одной
  // миллисекунды схлопывались бы в равные и порядок зависел бы от
  // ответа источника.
  return [...entries].sort((left, right) => {
    const difference = BigInt(left.tsNs) - BigInt(right.tsNs);
    if (difference < 0n) return -1;
    return difference > 0n ? 1 : 0;
  });
}

/** Записи в текст: по строке на запись, с префиксом времени по флагу. */
export function formatEntries(
  entries: readonly LogEntry[],
  timestamps: boolean,
): string {
  return entries
    .map((entry) =>
      `${timestamps ? `${isoOf(entry.tsNs)} ` : ""}${text(entry.line)}\n`
    )
    .join("");
}

/** Время записи в UTC с миллисекундами: `YYYY-MM-DDThh:mm:ss.mmmZ`. */
function isoOf(tsNs: string): string {
  return new Date(Number(BigInt(tsNs) / 1_000_000n)).toISOString();
}

/** Текст записи без хвостового перевода строки: его добавляет печать. */
function text(line: string): string {
  return line.endsWith("\n") ? line.slice(0, -1) : line;
}
