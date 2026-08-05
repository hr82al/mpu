/**
 * Драйвер PostgreSQL для `mpu sql-ro`: единственная реализация порта
 * `OpenReadOnlySession` (`session.ts`) поверх node-postgres. Read-only
 * задаётся опцией стартового пакета, а пользовательский текст исполняется
 * внутри обёртки транзакцией с меткой — гарантию держит сервер
 * (`platform/readonly-default.md`), а не разбор текста запроса.
 *
 * Модуль грузится динамически из команды: npm-пакет не должен попадать в
 * путь запуска остальных команд (`ts/CLAUDE.md`, «Производительность»).
 */

import driver from "pg";
import type { SqlOutcome, SqlValue } from "./render.ts";
import {
  DbError,
  type ReadOnlySession,
  TransactionEndedError,
  WriteRefusedError,
} from "./session.ts";
import type { PgTarget } from "./target.ts";

/** Клиент драйвера: одно соединение, простой протокол, без пула. */
export interface PgClient {
  readonly connect: () => Promise<void>;
  readonly query: (
    config: { readonly text: string; readonly rowMode: "array" },
  ) => Promise<unknown>;
  readonly end: () => Promise<void>;
}

/** Ошибка, пришедшая от сервера: SQLSTATE и позиция в тексте запроса. */
interface DatabaseErrorLike extends Error {
  readonly code?: string;
  readonly position?: string;
}

/** Часть поверхности драйвера, которой пользуется модуль. */
interface PgDriver {
  readonly Client: new (options: ClientOptions) => PgClient;
  readonly DatabaseError: abstract new (
    ...args: never[]
  ) => DatabaseErrorLike;
  readonly types: {
    readonly getTypeParser: (
      oid: number,
      format?: string,
    ) => (value: string) => unknown;
  };
}

/**
 * Опции подключения — те, что этот модуль задаёт явно (см. `clientOptions`).
 *
 * Приведение, а не типы пакета: `pg` их не несёт, отдельный пакет типов
 * тянет за собой типы всей платформы Node, а зовём мы пять членов.
 * Ошибку в имени опции ловит smoke-сценарий на живом соединении, а не
 * компилятор — цена названа осознанно.
 */
const pg = driver as PgDriver;

export interface ClientOptions {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly application_name: string;
  readonly options: string;
  readonly ssl: false;
  readonly sslnegotiation: "postgres";
  readonly client_encoding: string;
  readonly connectionTimeoutMillis: number;
  readonly types: {
    readonly getTypeParser: (
      oid: number,
      format?: string,
    ) => (value: string) => unknown;
  };
}

/** SQLSTATE отказа записи на read-only сессии. */
const READ_ONLY_SQL_TRANSACTION = "25006";

/** SQLSTATE снятия метки вне транзакции: текст завершил её сам. */
const NO_ACTIVE_SQL_TRANSACTION = "25P01";

/**
 * Метка подтранзакции обёртки — фиксированное имя реализации: из
 * пользовательского текста не строится и в него не подставляется.
 */
const MARK = "mpu_sql_ro";

/**
 * Обёртка, внутри которой исполняется пользовательский текст
 * (`platform/readonly-default.md`): `BEGIN READ ONLY` задаёт режим явно,
 * второй оператор берёт снимок, `SAVEPOINT` открывает подтранзакцию —
 * внутри неё сервер отклоняет переход в read-write безусловно, — а
 * снятие метки превращает самовольно завершённую транзакцию в отказ
 * вместо тихой записи. Операторы разделены переводами строк, и точка с
 * запятой после текста пользователя стоит на своей строке: хвостовой
 * `--`-комментарий иначе съел бы её вместе с замыкающими операторами.
 */
const WRAP_HEAD = "BEGIN READ ONLY;\n" +
  "SELECT current_setting('transaction_read_only');\n" +
  `SAVEPOINT ${MARK};\n`;

const WRAP_TAIL = `\n;\nROLLBACK TO SAVEPOINT ${MARK};\nROLLBACK`;

/**
 * Номер ответа, в котором лежит результат первого оператора текста
 * пользователя: до него в обёртке ровно три оператора. Константа формы,
 * а не поиск по содержимому ответов.
 */
const USER_RESULT = 3;

/**
 * Типы, значения которых берутся текстом сервера, а не разбираются
 * драйвером: у даты, времени и интервала JS-объект печатался бы не в
 * форме PostgreSQL, а спека требует текстовую форму значения. Прочие
 * типы остаются на разборщиках драйвера: число печатается числом, а
 * json — вложенной структурой (спека, «Ввод/вывод»).
 */
const TEXT_OIDS: ReadonlySet<number> = new Set([
  1082, // date
  1083, // time
  1114, // timestamp
  1184, // timestamptz
  1186, // interval
  1266, // timetz
]);

/** Как заводится клиент драйвера; шов для тестов без живого PostgreSQL. */
export type OpenClient = (options: ClientOptions) => PgClient;

/** Открывает сессию: соединение read-only и разбор результатов. */
export async function openPgSession(
  target: PgTarget,
  openClient: OpenClient = (options) => new pg.Client(options),
): Promise<ReadOnlySession> {
  const client = openClient(clientOptions(target));
  try {
    await client.connect();
  } catch (err) {
    // Клиент, который не подключился, всё равно закрываем — и молча:
    // причина отказа уже в `err`, а сбой закрытия несостоявшегося
    // соединения ей ничего не добавит.
    await client.end().catch(() => {});
    throw dbError(err, "");
  }
  return {
    query: async (text) => {
      try {
        return outcomeOf(await send(client, text));
      } catch (err) {
        throw dbError(err, text);
      }
    },
    run: async (sql) => {
      try {
        return outcomeAt(
          await send(client, WRAP_HEAD + sql + WRAP_TAIL),
          USER_RESULT,
        );
      } catch (err) {
        // Позицию ошибки сервер считает по всему отправленному тексту:
        // обёртка вычитается, иначе указатель встал бы мимо, а её
        // операторы попали бы пользователю в вывод.
        throw dbError(err, sql, WRAP_HEAD.length);
      }
    },
    close: () => client.end(),
  };
}

/**
 * Один вызов серверу. `rowMode: "array"` — строки массивами, а не
 * объектами: одинаковые имена колонок в выборке законны, а в объекте они
 * схлопнулись бы в одну. Простой протокол при этом сохраняется (значений
 * нет), поэтому многооператорный текст уходит одним вызовом.
 */
function send(client: PgClient, text: string): Promise<unknown> {
  return client.query({ text, rowMode: "array" });
}

/**
 * Опции клиента. Каждая, чьё значение драйвер иначе ищет в окружении
 * процесса, задана явно: конфигурация mpu живёт только в env-файле
 * (`platform/env-file.md`, решение 2026-08-05), и экспорт `PGHOST` или
 * `PGAPPNAME` в shell на поведение влиять не должен. Исключения —
 * `binary` и `replication`: их умолчание ложно, а ложное значение
 * драйвер за заданное не считает и всё равно смотрит в `PGBINARY` /
 * `PGREPLICATION` (см. `deno.jsonc`, право `--allow-env=PG*`).
 */
export function clientOptions(target: PgTarget): ClientOptions {
  return {
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.username,
    password: target.password,
    application_name: "mpu",
    // Опция стартового пакета: сессия открывается read-only с первого
    // байта, до всякого пользовательского SQL.
    options: "-c default_transaction_read_only=on",
    ssl: false,
    sslnegotiation: "postgres",
    client_encoding: "UTF8",
    // 0 — без предела на установление соединения, как у libpq и у
    // прежней реализации: ad-hoc запрос к далёкому стенду не должен
    // отваливаться по чужому умолчанию.
    connectionTimeoutMillis: 0,
    types: {
      getTypeParser: (oid, format) =>
        TEXT_OIDS.has(oid)
          ? (value: string) => value
          : pg.types.getTypeParser(oid, format),
    },
  };
}

/** Результат одиночного оператора: драйвер отдаёт один объект ответа. */
export function outcomeOf(result: unknown): SqlOutcome {
  const fields = readFields(result);
  if (fields.length === 0) {
    // Оператор без набора строк (`SET`): затронутых строк сервер не
    // сообщает — спека печатает такой случай как `-1`.
    return { kind: "done", rowcount: readRowCount(result) };
  }
  return {
    kind: "rows",
    columns: fields,
    rows: readRows(result).map((row) => row.map(toValue)),
  };
}

/**
 * Результат оператора под номером `index`: на многооператорный текст
 * драйвер отвечает массивом объектов результата. Текст пользователя, не
 * давший ни одного оператора (один комментарий), под этим номером
 * оставляет либо ответ замыкающего оператора обёртки, либо ничего — в
 * обоих случаях у него нет ни колонок, ни счётчика строк, и вызов
 * печатается как оператор без набора строк.
 */
export function outcomeAt(results: unknown, index: number): SqlOutcome {
  return outcomeOf(Array.isArray(results) ? results[index] : undefined);
}

/**
 * Ошибка драйвера в классы порта. Отказ записи различается по SQLSTATE,
 * а не по тексту сообщения (`platform/readonly-default.md`).
 */
export function dbError(err: unknown, text: string, offset = 0): Error {
  if (err instanceof pg.DatabaseError) {
    if (err.code === READ_ONLY_SQL_TRANSACTION) {
      return new WriteRefusedError(err.message, { cause: err });
    }
    if (err.code === NO_ACTIVE_SQL_TRANSACTION) {
      return new TransactionEndedError(err.message, { cause: err });
    }
    return new DbError(
      serverText(err.message, text, shift(err.position, offset)),
      {
        cause: err,
      },
    );
  }
  // Сюда попадает отказ соединения и прочие сбои клиента: для команды
  // это та же ошибка БД (спека даёт им один класс и один код выхода).
  return new DbError(err instanceof Error ? err.message : String(err), {
    cause: err,
  });
}

/**
 * Текст ошибки сервера с позицией: сообщение, строка запроса и указатель
 * под местом ошибки — форма libpq, которую печатала прежняя реализация
 * (эталон `db-error-stderr.txt`). Драйвер отдаёт только само сообщение и
 * позицию в символах, поэтому строку с указателем собираем здесь.
 */
export function serverText(
  message: string,
  query: string,
  position: string | undefined,
): string {
  const at = position === undefined ? NaN : Number(position);
  const chars = [...query];
  if (!Number.isInteger(at) || at < 1 || at > chars.length + 1) return message;
  const before = chars.slice(0, at - 1);
  const start = before.lastIndexOf("\n") + 1;
  const end = chars.indexOf("\n", start);
  const line = chars.slice(start, end === -1 ? chars.length : end).join("");
  const label = `LINE ${before.filter((char) => char === "\n").length + 1}: `;
  const caret = " ".repeat(label.length + (at - 1 - start));
  return `${message}\n${label}${line}\n${caret}^`;
}

/**
 * Позиция ошибки в координатах текста пользователя. Смещение — длина
 * обёртки в символах; она из ASCII, поэтому длина строки её и считает.
 */
function shift(
  position: string | undefined,
  offset: number,
): string | undefined {
  if (position === undefined) return undefined;
  const at = Number(position);
  return Number.isInteger(at) ? String(at - offset) : position;
}

/** Имена колонок результата; их нет — оператор без набора строк. */
function readFields(result: unknown): readonly string[] {
  const fields = (result as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(fields)) return [];
  return fields.map((field) => String((field as { name?: unknown }).name));
}

/** Затронутые строки; сервер их не сообщил — `-1` (форма спеки). */
function readRowCount(result: unknown): number {
  const count = (result as { rowCount?: unknown } | null)?.rowCount;
  return typeof count === "number" ? count : -1;
}

function readRows(result: unknown): readonly unknown[][] {
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows.map((row) => row as unknown[]) : [];
}

/**
 * Значение ячейки в JSON-представимое: структуры JSON-типов остаются
 * структурами, всё прочее без такого представления приводится к
 * текстовой форме (спека, «Ввод/вывод»).
 */
export function toValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  // Число, которого в JSON не бывает (`SELECT 'NaN'::float8`), уходит
  // текстом сервера: иначе оно не пережило бы схему результата, и вызов
  // упал бы «unexpected error» вместо таблицы.
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (Array.isArray(value)) return value.map(toValue);
  if (value instanceof Uint8Array) return `\\x${hex(value)}`;
  if (value instanceof Date) return value.toISOString();
  if (isPlainObject(value)) {
    const out: Record<string, SqlValue> = {};
    for (const [key, item] of Object.entries(value)) out[key] = toValue(item);
    return out;
  }
  return String(value);
}

/** Только литеральные объекты (json/jsonb); классы драйвера — текстом. */
function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Текстовая форма bytea — та же, что печатает сам PostgreSQL. */
function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
