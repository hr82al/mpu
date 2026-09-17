/**
 * Драйвер PG для синка снапшота: единственная реализация порта
 * `OpenPgSession` (`sync.ts`) поверх node-postgres. Адреса и креды — из
 * env-файла (`platform/env-file.md`), сессия — read-only гарантией
 * сервера (`platform/readonly-default.md`), запросы — фиксированные
 * спекой (`docs/specs/update.md`), параметризованные там, где сужаются
 * до одного клиента.
 *
 * Модуль грузится динамически из команды: npm-пакет не должен попадать
 * в путь запуска остальных команд (`ts/CLAUDE.md`, «Производительность»).
 */

import driver from "pg";
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

/**
 * Проверка того, что запрет записи действует на самом соединении, а не
 * предполагается по факту отправки опции (`platform/readonly-default.md`,
 * «Инварианты»). Цена — одно обращение на сессию, принята осознанно.
 */
const READ_ONLY_CHECK = "SELECT current_setting('transaction_read_only') AS ro";

/** Подключение не сложилось: нет ключа env-файла либо он не число. */
export class PgConfigError extends Error {
  override name = "PgConfigError";
}

/** Соединение открылось, но запрет записи на нём не действует. */
export class PgNotReadOnlyError extends Error {
  override name = "PgNotReadOnlyError";
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

/** Клиент драйвера: класс `Client` и есть одно физическое соединение. */
export interface PgClient {
  readonly connect: () => Promise<void>;
  readonly query: (
    config: { readonly text: string; readonly values: readonly unknown[] },
  ) => Promise<{ readonly rows: readonly unknown[] }>;
  readonly end: () => Promise<void>;
  /** Ошибка соединения приходит и сюда: без слушателя она роняет процесс. */
  readonly on: (event: "error", handler: (err: Error) => void) => void;
}

/** Часть поверхности драйвера, которой пользуется модуль. */
interface PgDriver {
  readonly Client: new (options: ClientOptions) => PgClient;
}

/**
 * Приведение, а не типы пакета: `pg` их не несёт, отдельный пакет типов
 * тянет за собой типы всей платформы Node, а зовём мы четыре члена.
 * Ошибку в имени опции ловит smoke-сценарий на живом соединении.
 */
const pg = driver as PgDriver;

/** Опции подключения — те, что этот модуль задаёт явно. */
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
}

/** Имя выборки спеки; текст каждой зафиксирован там же. */
export type SelectName = "clients" | "spreadsheets" | "wbSids";

/** Запрос драйверу: текст и связанные значения. */
export interface PgQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

/**
 * Три выборки спеки (`docs/specs/update.md`) в двух видах: по всему
 * серверу и суженная до одного клиента (точечный синк).
 */
const SELECTS: Readonly<Record<SelectName, { all: string; one: string }>> = {
  clients: {
    all: "SELECT id, server, is_active, is_locked, is_deleted" +
      " FROM public.clients",
    one: "SELECT id, server, is_active, is_locked, is_deleted" +
      " FROM public.clients WHERE id = $1",
  },
  spreadsheets: {
    all: "SELECT client_id, spreadsheet_id, title, template_name, is_active" +
      " FROM public.spreadsheets",
    one: "SELECT client_id, spreadsheet_id, title, template_name, is_active" +
      " FROM public.spreadsheets WHERE client_id = $1",
  },
  wbSids: {
    all: "SELECT DISTINCT client_id, sid FROM public.wb_tokens" +
      " WHERE sid IS NOT NULL",
    one: "SELECT DISTINCT client_id, sid FROM public.wb_tokens" +
      " WHERE sid IS NOT NULL AND client_id = $1",
  },
};

/**
 * Запрос выборки. Сужение до клиента уходит связанным значением, а не
 * склейкой текста: подставлять в SQL число, пришедшее аргументом
 * команды, нельзя даже когда оно уже разобрано как целое.
 */
export function selectQuery(
  name: SelectName,
  clientId: number | undefined,
): PgQuery {
  const texts = SELECTS[name];
  return clientId === undefined
    ? { text: texts.all, values: [] }
    : { text: texts.one, values: [clientId] };
}

/**
 * Как заводится клиент драйвера. Подмена нужна тестам: живого
 * PostgreSQL у них нет, а порядок шагов открытия сессии — проверять
 * надо (`platform/readonly-default.md`: сессия без действующего запрета
 * записи к работе не допускается).
 */
export type OpenClient = (options: ClientOptions) => PgClient;

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
  openClient: OpenClient = (options) => new pg.Client(options),
): OpenPgSession {
  return async (serverNumber, { signal }) => {
    const client = openClient(
      clientOptions(readTarget(envFile, serverNumber), limits),
    );
    // Слушатель обязателен: разрыв соединения вне запроса приходит
    // событием, и незанятое `error` у EventEmitter роняет процесс
    // (замерено). Сама причина отказа доедет до вызывающего отказом
    // ближайшего запроса — здесь её терять не жалко.
    client.on("error", () => {});
    try {
      // Соединение устанавливается здесь, а не лениво первым запросом:
      // иначе предел на установление соединения было бы нечем
      // ограничивать, а спека требует ограничить оба обращения.
      await guard(client.connect(), signal, client);
      return await openSession(client, signal);
    } catch (err) {
      // Клиент закрывается молча: причина отказа уже в `err`, а сбой
      // закрытия несостоявшегося соединения ей ничего не добавит.
      await client.end().catch(() => {});
      throw err;
    }
  };
}

/**
 * Опции клиента. Каждая, чьё значение драйвер иначе ищет в окружении
 * процесса, задана явно: конфигурация mpu живёт только в env-файле
 * (`platform/env-file.md`, решение 2026-08-05), и экспорт `PGHOST` или
 * `PGAPPNAME` в shell на поведение влиять не должен.
 *
 * Оба предела времени — в миллисекундах, как их объявляет порт:
 * `connectionTimeoutMillis` драйвер понимает миллисекундами, а
 * `statement_timeout` — GUC сессии, и его единица тоже миллисекунда.
 */
export function clientOptions(
  target: PgTarget,
  limits: PgLimits,
): ClientOptions {
  return {
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.username,
    password: target.password,
    application_name: "mpu",
    // Опции стартового пакета: запрет записи держит сервер, а не разбор
    // текста запроса (`platform/readonly-default.md`), а предел запроса
    // — тот же GUC, что стоял раньше: отказ приходит от сервера, а не
    // вторым клиентским таймером поверх сигнала отмены.
    options: `-c default_transaction_read_only=on` +
      ` -c statement_timeout=${limits.queryMs}`,
    ssl: false,
    sslnegotiation: "postgres",
    client_encoding: "UTF8",
    connectionTimeoutMillis: limits.connectMs,
  };
}

/**
 * Сессия на уже подключённом клиенте: сперва проверка запрета записи,
 * потом выборки. Отдельно от `makePgOpener`, потому что подключение —
 * единственное, чего нельзя проверить без живого PostgreSQL, а порядок
 * шагов проверить нужно.
 */
export async function openSession(
  client: PgClient,
  signal: AbortSignal,
): Promise<PgSession> {
  await assertReadOnly(client, signal);
  return session(client);
}

/**
 * Запрет записи проверяется на самом соединении: опция стартового
 * пакета могла быть потеряна пулером или переопределена ролью, и такое
 * соединение к работе не допускается (`platform/readonly-default.md`).
 */
async function assertReadOnly(
  client: PgClient,
  signal: AbortSignal,
): Promise<void> {
  const rows = await queryRows(client, { text: READ_ONLY_CHECK, values: [] }, {
    signal,
  });
  if (rows[0]?.ro === "on") return;
  throw new PgNotReadOnlyError(
    `сессия не read-only: transaction_read_only=${rows[0]?.ro ?? "?"}`,
  );
}

/** Три выборки спеки на открытом соединении. */
function session(client: PgClient): PgSession {
  const select = (name: SelectName) => (options: SelectOptions) =>
    queryRows(client, selectQuery(name, options.clientId), options);
  return {
    clients: select("clients"),
    spreadsheets: select("spreadsheets"),
    wbSids: select("wbSids"),
    close: () => client.end(),
  };
}

/** Строки выборки под сигналом отмены. */
async function queryRows(
  client: PgClient,
  query: PgQuery,
  options: { readonly signal: AbortSignal },
): Promise<readonly PgRow[]> {
  const result = await guard(client.query(query), options.signal, client);
  // Драйвер типизирует значения колонок как `any` (форму выборки он не
  // знает). Сужение приведением, а не проверкой каждой строки: формы
  // фиксированы спекой, а негодное значение поймает разбор в `cache.ts`
  // — там же, где ошибка называет колонку.
  return result.rows as readonly PgRow[];
}

/**
 * Ждёт работу драйвера, пока не сработал сигнал. Сработал — соединение
 * гасится принудительно: этим драйвер отклоняет незавершённый запрос,
 * тогда как отмена протоколом доставки не гарантирует и зависший запрос
 * мог бы пережить свой предел.
 */
async function guard<T>(
  work: Promise<T>,
  signal: AbortSignal,
  client: PgClient,
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
    // По сработавшему сигналу соединение гасится молча: наружу уйдёт
    // причина отмены, а не то, чем ответил рвущийся клиент.
    if (signal.aborted) await client.end().catch(() => {});
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
