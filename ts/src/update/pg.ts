/**
 * Драйвер PG для синка снапшота: единственная реализация порта
 * `OpenPgSession` (`sync.ts`) поверх postgres-js. Адреса и креды — из
 * env-файла (`platform/env-file.md`), сессия — read-only гарантией
 * сервера (`platform/readonly-default.md`), запросы — фиксированные
 * спекой (`docs/specs/update.md`), tagged template на каждый.
 *
 * Модуль грузится динамически из команды: npm-пакет не должен попадать
 * в путь запуска остальных команд (`ts/CLAUDE.md`, «Производительность»).
 */

import postgres from "postgres";
import type {
  OpenPgSession,
  PgLimits,
  PgSession,
  SelectOptions,
} from "./sync.ts";
import type { PgRow } from "./cache.ts";

/** Порт PG по умолчанию (`platform/env-file.md`). */
const DEFAULT_PORT = 5432;

/** Имя БД по умолчанию (`platform/env-file.md`). */
const DEFAULT_DATABASE = "wb";

/** Подключение не сложилось: нет ключа env-файла либо он не число. */
export class PgConfigError extends Error {
  override name = "PgConfigError";
}

/** Куда и под кем подключаться: всё из env-файла, без окружения процесса. */
interface PgTarget {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
}

/** Читает ключ env-файла; пустое значение равнозначно отсутствию. */
interface EnvKeys {
  readonly get: (name: string) => string | undefined;
}

/**
 * Открыватель сессий: на каждый сервер — своё подключение с адресом
 * `pg_<N>` из env-файла. Пределы времени соблюдаются двумя способами
 * сразу: сигналом отмены от вызывающего (порт `sync.ts`) и опциями
 * самого драйвера — соединение и запрос не должны пережить команду
 * даже при потерянном сигнале.
 */
export function makePgOpener(
  envFile: EnvKeys,
  limits: PgLimits,
): OpenPgSession {
  return async (serverNumber, { signal }) => {
    const sql = connect(readTarget(envFile, serverNumber), limits);
    try {
      // Соединение устанавливается здесь, а не лениво первым запросом:
      // иначе предел на установление соединения было бы нечем
      // ограничивать, а спека требует ограничить оба обращения.
      const reserved = await guard(sql.reserve(), signal, sql);
      return session(sql, reserved);
    } catch (err) {
      await sql.end({ timeout: 0 });
      throw err;
    }
  };
}

/**
 * Клиент postgres-js. Каждая опция задана явно — иначе драйвер идёт за
 * её значением в окружение процесса (`PGMAX`, `PGCONNECT_TIMEOUT`, …), а
 * конфигурация mpu живёт только в env-файле (`platform/env-file.md`,
 * решение 2026-08-05). Единственная переменная, которую отнять у
 * драйвера нельзя, — `PGAPPNAME`: он читает её до слияния с опциями;
 * значение при этом отбрасывается нашим `application_name`, поэтому
 * право на чтение есть, а влияния на поведение нет.
 */
function connect(target: PgTarget, limits: PgLimits): postgres.Sql {
  const options: ClientOptions = {
    host: target.host,
    port: target.port,
    database: target.database,
    username: target.username,
    password: target.password,
    // Сессия — это одно соединение: пул на одну команду не нужен.
    max: 1,
    ssl: false,
    sslnegotiation: null,
    idle_timeout: undefined,
    connect_timeout: Math.ceil(limits.connectMs / 1000),
    max_lifetime: null,
    max_pipeline: 100,
    backoff: (retries: number) => Math.min(retries, 5),
    keep_alive: 60,
    // Именованные prepared statement'ы не переживают pgbouncer в
    // transaction-режиме, а порт стенда (`PG_PORT`) на него и указывает.
    prepare: false,
    debug: false,
    // Каталог типов на каждом соединении не нужен: в выборках спеки
    // только int, text и bool — их драйвер разбирает без справочника.
    fetch_types: false,
    publications: "alltables",
    // Запрет записи держит сервер, а не разбор текста запроса
    // (`platform/readonly-default.md`): опция стартового пакета ниже
    // включает его, а `target_session_attrs` проверяет, что включился.
    target_session_attrs: "read-only",
    connection: {
      application_name: "mpu",
      default_transaction_read_only: true,
      statement_timeout: limits.queryMs,
    },
    // Уведомления сервера — не данные команды: в stdout им нельзя, а
    // умолчание драйвера печатает их именно туда.
    onnotice: () => {},
  };
  return postgres(options);
}

/**
 * Опции клиента: тип пакета плюс те, что его реализация 3.4.9 читает, а
 * типы того же выпуска не объявляют. Не передать их нельзя — не найдя
 * опции, драйвер идёт за значением в окружение процесса
 * (`PGSSLNEGOTIATION`, `PGMAX_PIPELINE`).
 */
type ClientOptions = postgres.Options<Record<string, never>> & {
  readonly sslnegotiation: string | null;
  readonly max_pipeline: number;
};

/** Три выборки спеки на зарезервированном соединении. */
function session(sql: postgres.Sql, reserved: postgres.ReservedSql): PgSession {
  return {
    clients: ({ signal, clientId }) =>
      rows(
        clientId === undefined
          ? reserved`
              SELECT id, server, is_active, is_locked, is_deleted
              FROM public.clients`
          : reserved`
              SELECT id, server, is_active, is_locked, is_deleted
              FROM public.clients WHERE id = ${clientId}`,
        signal,
        sql,
      ),
    spreadsheets: ({ signal, clientId }) =>
      rows(
        clientId === undefined
          ? reserved`
              SELECT client_id, spreadsheet_id, title, template_name, is_active
              FROM public.spreadsheets`
          : reserved`
              SELECT client_id, spreadsheet_id, title, template_name, is_active
              FROM public.spreadsheets WHERE client_id = ${clientId}`,
        signal,
        sql,
      ),
    wbSids: ({ signal, clientId }) =>
      rows(
        clientId === undefined
          ? reserved`
              SELECT DISTINCT client_id, sid
              FROM public.wb_tokens WHERE sid IS NOT NULL`
          : reserved`
              SELECT DISTINCT client_id, sid
              FROM public.wb_tokens
              WHERE sid IS NOT NULL AND client_id = ${clientId}`,
        signal,
        sql,
      ),
    close: async () => {
      reserved.release();
      await sql.end({ timeout: 0 });
    },
  };
}

/** Строки выборки под сигналом отмены. */
async function rows(
  query: Promise<postgres.RowList<postgres.Row[]>>,
  signal: SelectOptions["signal"],
  sql: postgres.Sql,
): Promise<readonly PgRow[]> {
  const result = await guard(query, signal, sql);
  // Драйвер типизирует значения колонок как `any` (форму выборки он не
  // знает). Сужение приведением, а не проверкой каждой строки: формы
  // фиксированы спекой, а негодное значение поймает разбор в `cache.ts`
  // — там же, где ошибка называет колонку.
  return [...result] as readonly PgRow[];
}

/**
 * Ждёт работу драйвера, пока не сработал сигнал. Сработал — соединение
 * гасится принудительно: postgres-js отклоняет этим незавершённые
 * запросы, тогда как отмена протоколом (`cancel()`) доставки не
 * гарантирует и зависший запрос мог бы пережить свой предел.
 */
async function guard<T>(
  work: Promise<T>,
  signal: AbortSignal,
  sql: postgres.Sql,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
  try {
    return await Promise.race([work, aborted]);
  } catch (err) {
    if (signal.aborted) await sql.end({ timeout: 0 });
    throw err;
  }
}

/** Адрес и креды сервера sl-N из env-файла. */
function readTarget(envFile: EnvKeys, serverNumber: number): PgTarget {
  return {
    host: requireValue(envFile, `pg_${serverNumber}`),
    port: portOf(value(envFile, "PG_PORT")),
    database: value(envFile, "PG_DB_NAME") ?? DEFAULT_DATABASE,
    // Личные креды приоритетнее общих (`platform/env-file.md`), каждый
    // ключ независимо: пары «имя+пароль» слой не знает.
    username: either(envFile, "PG_MY_USER_NAME", "PG_MAIN_USER_NAME"),
    password: either(envFile, "PG_MY_USER_PASSWORD", "PG_MAIN_USER_PASSWORD"),
  };
}

function portOf(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new PgConfigError(`PG_PORT: ожидался номер порта, задано '${raw}'`);
  }
  return port;
}

/** Значение ключа; пустая строка равнозначна отсутствию ключа. */
function value(envFile: EnvKeys, name: string): string | undefined {
  const raw = envFile.get(name);
  return raw === undefined || raw === "" ? undefined : raw;
}

function requireValue(envFile: EnvKeys, name: string): string {
  const raw = value(envFile, name);
  if (raw === undefined) {
    throw new PgConfigError(`${name} не задан в env-файле`);
  }
  return raw;
}

function either(envFile: EnvKeys, personal: string, common: string): string {
  const raw = value(envFile, personal) ?? value(envFile, common);
  if (raw === undefined) {
    throw new PgConfigError(`${personal} или ${common} не задан в env-файле`);
  }
  return raw;
}
