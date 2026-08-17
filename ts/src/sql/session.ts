/**
 * Сессия PostgreSQL глазами команды: узкий порт на стороне потребителя.
 * Единственная реализация — `pg.ts` поверх драйвера; тесты подставляют
 * свою (живого PostgreSQL у них нет, `specs/sql-ro.md`, «Golden-примеры»).
 */

import type { SqlOutcome } from "./render.ts";
import type { PgTarget } from "./target.ts";

/** Открытое соединение: один вызов команды — одна сессия. */
export interface SqlSession {
  /**
   * Служебный запрос самой команды: доверенный текст из одного оператора
   * (проверка режима, `SET search_path`). Идёт серверу как есть —
   * обёртка откатывала бы его действие вместе со своей транзакцией.
   */
  readonly query: (text: string) => Promise<SqlOutcome>;
  /**
   * Отправляет пользовательский текст серверу одним вызовом, без
   * параметризации и разбиения, внутри обёртки транзакцией с меткой
   * (`platform/readonly-default.md`), и отдаёт результат ПЕРВОГО его
   * оператора. Ошибка любого оператора — отказ всего вызова (спека,
   * «Граничные случаи»).
   */
  readonly run: (sql: string) => Promise<SqlOutcome>;
  readonly close: () => Promise<void>;
}

/** Открыватель сессии: read-only задаётся при подключении. */
export type OpenSession = (
  target: PgTarget,
) => Promise<SqlSession>;

/**
 * Сервер отклонил запись (SQLSTATE 25006). Отдельный класс, потому что
 * команда печатает на него свой текст, а не текст сервера
 * (`platform/readonly-default.md`).
 */
export class WriteRefusedError extends Error {
  override name = "WriteRefusedError";
}

/**
 * Текст пользователя сам распорядился транзакцией вызова (`COMMIT`
 * внутри него — с открытием новой транзакции или без), и метки обёртки
 * снять уже не с чего — SQLSTATE 25P01 или 3B001.
 * Гарантия только-чтения на остаток текста не действовала, поэтому
 * команда печатает свой текст и не печатает результат.
 */
export class TransactionEndedError extends Error {
  override name = "TransactionEndedError";
}

/**
 * Прочий отказ БД. Сообщение — текст сервера целиком, включая позицию и
 * указатель на место ошибки: команда печатает его как есть.
 */
export class DbError extends Error {
  override name = "DbError";
}
