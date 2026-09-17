/**
 * Отбор записей журнала (`docs/specs/log.md`, «Ввод/вывод»). Порядок
 * ступеней наблюдаем и потому задан здесь явно: сначала признаки
 * записи (`--failed`, `--cmd`, `--since`), и только потом хвост
 * (`--tail`).
 *
 * Перепутать ступени — значит поменять смысл вызова: `--tail 20
 * --failed` обещает двадцать последних упавших, а не упавшие среди
 * двадцати последних.
 */

import type { LogRecord } from "./parse.ts";

/** Чем отбирают записи; не заданное поле ступень не создаёт. */
export interface Filters {
  readonly failed: boolean;
  /** Префикс строки вызова после `mpu `. */
  readonly cmd?: string;
  /** Нижняя граница момента записи в unix-секундах, включительно. */
  readonly since?: number;
  /** Сколько последних записей оставить; `0` и меньше — все (спека). */
  readonly tail: number;
}

/** Отобранные записи в порядке файла: отбор порядок не меняет. */
export function selectRecords(
  records: readonly LogRecord[],
  filters: Filters,
): readonly LogRecord[] {
  const matched = records.filter((record) => matches(record, filters));
  return filters.tail > 0 ? matched.slice(-filters.tail) : matched;
}

/** Запись по идентификатору вызова: совпадение точное, не префиксное. */
export function recordOfRun(
  records: readonly LogRecord[],
  runId: string,
): LogRecord | null {
  return records.find((record) => record.runId === runId) ?? null;
}

function matches(record: LogRecord, filters: Filters): boolean {
  // Оборванная запись кодом не отбирается: его у неё нет, а выдумывать
  // «успех» значило бы прятать обрыв от `--failed`.
  if (filters.failed && (record.exitCode === null || record.exitCode === 0)) {
    return false;
  }
  if (filters.cmd !== undefined && !hasPrefix(record, filters.cmd)) {
    return false;
  }
  if (filters.since !== undefined) {
    // Нечитаемое время шапки видно без `--since` и всегда отсеивается
    // любым `--since` (спека, «Граничные случаи»).
    if (record.startedAt === null || record.startedAt < filters.since) {
      return false;
    }
  }
  return true;
}

/**
 * Строка вызова начинается с `mpu <префикс>`. Границу токена правило не
 * проверяет намеренно (отклонение `preserve`): тем же префиксом
 * отбираются подкоманды, и `--cmd sql` заодно ловит `sql-ro`.
 */
function hasPrefix(record: LogRecord, cmd: string): boolean {
  return record.commandLine.startsWith(`mpu ${cmd}`);
}
