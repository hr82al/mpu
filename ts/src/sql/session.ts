/**
 * Сессия PostgreSQL глазами команды: узкий порт на стороне потребителя.
 * Единственная реализация — `pg.ts` поверх драйвера; тесты подставляют
 * свою (живого PostgreSQL у них нет, `specs/sql-ro.md`, «Golden-примеры»).
 */

import type { SqlOutcome } from "./render.ts";
import type { PgTarget } from "./target.ts";

/**
 * Режим сессии — единственное, чем `mpu sql` отличается от `mpu sql-ro`
 * на стороне соединения (`specs/sql.md`, «CLI-контракт»): read-only
 * задаётся опцией стартового пакета и обёрткой с меткой, write —
 * обычной транзакцией, которая фиксируется.
 *
 * Одно значение на весь вызов: из него выводятся и опции подключения, и
 * форма обёртки, и строка `mode` мета-блока.
 */
export type SqlMode = "read-only" | "write";

/** Открытое соединение: один вызов команды — одна сессия. */
export interface SqlSession {
  /**
   * Служебный запрос самой команды: доверенный текст из одного оператора
   * (проверка режима, `SET search_path`). Идёт серверу как есть —
   * обёртка откатывала бы его действие вместе со своей транзакцией.
   */
  readonly query: (
    text: string,
    params?: readonly unknown[],
  ) => Promise<SqlOutcome>;
  /**
   * Отправляет пользовательский текст серверу как есть, без
   * параметризации и разбиения, внутри транзакции вызова, и отдаёт
   * результат ПЕРВОГО его оператора. Ошибка любого оператора — отказ
   * всего вызова (спека, «Граничные случаи»). Форма транзакции зависит
   * от режима: у read-only это обёртка с меткой
   * (`platform/readonly-default.md`), у write — `BEGIN` … `COMMIT`, а
   * при ошибке вместо фиксации откат (`specs/sql.md`, «Инварианты»).
   */
  readonly run: (sql: string) => Promise<SqlOutcome>;
  /**
   * Несколько операторов со значениями-параметрами одной транзакцией:
   * `BEGIN`, каждый оператор отдельным вызовом, `COMMIT`. Отказ
   * оператора списка — `ROLLBACK` и `StatementError` с его номером и
   * меткой; отказ самих `BEGIN` и `COMMIT` относится не к оператору, а
   * к транзакции, и приходит обычной ошибкой БД.
   *
   * Отдельно от `run`, а не флагом в нём: расширенный протокол несёт
   * ровно один оператор на вызов, поэтому «весь текст одним вызовом» и
   * «значения параметрами» — взаимоисключающие способы, и выбирает
   * между ними вызывающий. Транзакция при этом одна на весь список:
   * посев, упавший на середине, не должен оставлять приёмник хуже, чем
   * до запуска (`docs/specs/copy-client.md`, шаг 3).
   */
  readonly runMany: (
    statements: readonly Statement[],
  ) => Promise<readonly SqlOutcome[]>;
  readonly close: () => Promise<void>;
}

/** Оператор со значениями: текст с `$1`, `$2`, … и сами значения. */
export interface Statement {
  readonly sql: string;
  /** Значения по местам `$n`; не заданы — оператор без параметров. */
  readonly params?: readonly unknown[];
  /** Чем назвать оператор в тексте отказа: имя таблицы, шаг. */
  readonly label?: string;
}

/**
 * Отказ одного оператора списка: кто именно упал, видно по номеру и
 * метке. Без них вызывающий знает только «посев не прошёл» — а ему
 * нужно назвать оператору таблицу, на которой встало.
 */
export class StatementError extends Error {
  override name = "StatementError";
  constructor(
    readonly index: number,
    readonly label: string | undefined,
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
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
