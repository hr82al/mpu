/**
 * Сессия PostgreSQL глазами команды: узкий порт на стороне потребителя.
 * Единственная реализация — `pg.ts` поверх драйвера; тесты подставляют
 * свою (живого PostgreSQL у них нет, `specs/sql-ro.md`, «Golden-примеры»).
 */

import type { SqlOutcome } from "./render.ts";
import type { PgTarget } from "./target.ts";

/** Открытое соединение: один вызов команды — одна сессия. */
export interface ReadOnlySession {
  /**
   * Отправляет текст серверу одним вызовом, без параметризации и
   * разбиения, и отдаёт результат ПЕРВОГО оператора. Ошибка любого
   * оператора — отказ всего вызова (спека, «Граничные случаи»).
   */
  readonly query: (text: string) => Promise<SqlOutcome>;
  readonly close: () => Promise<void>;
}

/** Открыватель сессии: read-only задаётся при подключении. */
export type OpenReadOnlySession = (
  target: PgTarget,
) => Promise<ReadOnlySession>;

/**
 * Сервер отклонил запись (SQLSTATE 25006). Отдельный класс, потому что
 * команда печатает на него свой текст, а не текст сервера
 * (`platform/readonly-default.md`).
 */
export class WriteRefusedError extends Error {
  override name = "WriteRefusedError";
}

/**
 * Прочий отказ БД. Сообщение — текст сервера целиком, включая позицию и
 * указатель на место ошибки: команда печатает его как есть.
 */
export class DbError extends Error {
  override name = "DbError";
}
