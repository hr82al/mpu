/**
 * Драйвер PostgreSQL для `mpu sql-ro` и `mpu sql`: единственная
 * реализация порта `OpenSession` (`session.ts`) поверх node-postgres.
 * Read-only задаётся опцией стартового пакета, а пользовательский текст
 * исполняется внутри обёртки транзакцией с меткой — гарантию держит
 * сервер (`platform/readonly-default.md`), а не разбор текста запроса.
 * Пишущая сессия открывается без этой опции и исполняет текст в обычной
 * транзакции (`specs/sql.md`, «Инварианты»).
 *
 * Модуль грузится динамически из команды: npm-пакет не должен попадать в
 * путь запуска остальных команд (`ts/CLAUDE.md`, «Производительность»).
 */

import driver from "pg";
import type { SqlOutcome, SqlValue } from "./render.ts";
import {
  DbError,
  type SqlMode,
  type SqlSession,
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

/** Опция стартового пакета, которой держится read-only сессия. */
const READ_ONLY_OPTION = "-c default_transaction_read_only=on";

/** SQLSTATE отказа записи на read-only сессии. */
const READ_ONLY_SQL_TRANSACTION = "25006";

/**
 * SQLSTATE снятия потерянной метки: текст распорядился транзакцией
 * вызова сам, и на его остаток гарантия только-чтения не действовала.
 * Кодов два, потому что путей два: `COMMIT` закрывает транзакцию
 * (`25P01`), а `COMMIT; BEGIN …` открывает вместо неё чужую, где метки
 * нет (`3B001`).
 */
const NO_ACTIVE_SQL_TRANSACTION = "25P01";
const INVALID_SAVEPOINT_SPECIFICATION = "3B001";

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
 * Транзакция пишущего вызова: операторы уходят драйверу порознь, чтобы
 * фиксация и откат были разными обращениями к серверу — «при ошибке
 * вместо фиксации — откат» (`specs/sql.md`, «Инварианты»). Склейка в
 * один текст этого различить не позволяет: `COMMIT` уехал бы серверу и
 * на ошибочном пути.
 */
const BEGIN = "BEGIN";
const COMMIT = "COMMIT";
const ROLLBACK = "ROLLBACK";

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

/** Открывает сессию в заданном режиме и разбирает результаты. */
export async function openPgSession(
  target: PgTarget,
  mode: SqlMode,
  openClient: OpenClient = (options) => new pg.Client(options),
): Promise<SqlSession> {
  const client = openClient(clientOptions(target, mode));
  try {
    await client.connect();
  } catch (err) {
    // Клиент, который не подключился, всё равно закрываем — и молча:
    // причина отказа уже в `err`, а сбой закрытия несостоявшегося
    // соединения ей ничего не добавит.
    await client.end().catch(() => {});
    throw dbError(err, "", { mode });
  }
  return {
    query: async (text) => {
      try {
        return outcomeOf(await send(client, text));
      } catch (err) {
        throw dbError(err, text, { mode });
      }
    },
    run: (sql) =>
      mode === "read-only" ? readOnlyRun(client, sql) : writeRun(client, sql),
    close: () => client.end(),
  };
}

/**
 * Пользовательский текст внутри обёртки с меткой: она уходит одним
 * вызовом вместе с ним, поэтому снять режим только-чтения из самого
 * текста нельзя (`platform/readonly-default.md`).
 */
async function readOnlyRun(
  client: PgClient,
  sql: string,
): Promise<SqlOutcome> {
  try {
    return outcomeAt(
      await send(client, WRAP_HEAD + sql + WRAP_TAIL),
      USER_RESULT,
    );
  } catch (err) {
    // Позицию ошибки сервер считает по всему отправленному тексту:
    // обёртка вычитается, иначе указатель встал бы мимо, а её
    // операторы попали бы пользователю в вывод.
    throw dbError(err, sql, {
      mode: "read-only",
      offset: WRAP_HEAD.length,
    });
  }
}

/**
 * Пользовательский текст в транзакции вызова: открытие, текст,
 * фиксация — тремя обращениями, и при ошибке вместо фиксации откат
 * (`specs/sql.md`, «Инварианты»). Частичной записи не бывает: сервер
 * держит открытую транзакцию до одного из двух завершающих операторов.
 */
async function writeRun(client: PgClient, sql: string): Promise<SqlOutcome> {
  await sendWrite(client, BEGIN);
  let outcome: SqlOutcome;
  try {
    outcome = firstOutcome(await send(client, sql));
  } catch (err) {
    // Откат собственного отказа не скрывает: наверх идёт исходная
    // ошибка, иначе пользователь увидел бы «current transaction is
    // aborted» вместо своей синтаксической.
    await send(client, ROLLBACK).catch(() => {});
    throw dbError(err, sql, { mode: "write" });
  }
  // Отказ самой фиксации (отложенный констрейнт) сервер откатывает
  // сам — своего `ROLLBACK` за ним не нужно.
  await sendWrite(client, COMMIT);
  return outcome;
}

/** Служебный оператор транзакции; его отказ — та же ошибка БД. */
async function sendWrite(client: PgClient, text: string): Promise<void> {
  try {
    await send(client, text);
  } catch (err) {
    throw dbError(err, text, { mode: "write" });
  }
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
export function clientOptions(
  target: PgTarget,
  mode: SqlMode,
): ClientOptions {
  return {
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.username,
    password: target.password,
    application_name: "mpu",
    // Опция стартового пакета: read-only сессия открывается такой с
    // первого байта, до всякого пользовательского SQL. У пишущей опций
    // нет по спеке (`specs/sql.md`, «CLI-контракт») — и пустая строка
    // фолбэк драйвера не закрывает: `PGOPTIONS` окружения он на ней
    // всё-таки читает. Непустое нейтральное значение закрыло бы это,
    // но вернуло бы в стартовый пакет параметр, которого спека у
    // пишущей сессии не предусматривает (цена — отказ пулера,
    // `platform/readonly-default.md`).
    options: mode === "read-only" ? READ_ONLY_OPTION : "",
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
 * Результат первого оператора текста, ушедшего отдельным вызовом: на
 * многооператорный текст драйвер отвечает массивом, на одиночный —
 * одним объектом.
 */
function firstOutcome(result: unknown): SqlOutcome {
  return Array.isArray(result) ? outcomeOf(result[0]) : outcomeOf(result);
}

/** Как читать отказ сервера: режим сессии и сдвиг позиции ошибки. */
export interface DbErrorContext {
  readonly mode: SqlMode;
  readonly offset?: number;
}

/**
 * Ошибка драйвера в классы порта. Отказ записи различается по SQLSTATE,
 * а не по тексту сообщения (`platform/readonly-default.md`), и только на
 * read-only сессии: на пишущей те же коды приходят от сервера, который
 * сам работает в режиме только-чтения (реплика), и своего текста про
 * `mpu sql` они не заслуживают — печатается текст сервера.
 */
export function dbError(
  err: unknown,
  text: string,
  context: DbErrorContext,
): Error {
  if (err instanceof pg.DatabaseError) {
    if (context.mode === "read-only") {
      if (err.code === READ_ONLY_SQL_TRANSACTION) {
        return new WriteRefusedError(err.message, { cause: err });
      }
      if (
        err.code === NO_ACTIVE_SQL_TRANSACTION ||
        err.code === INVALID_SAVEPOINT_SPECIFICATION
      ) {
        return new TransactionEndedError(err.message, { cause: err });
      }
    }
    return new DbError(
      serverText(err.message, text, shift(err.position, context.offset ?? 0)),
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
