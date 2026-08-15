/**
 * Синк снапшота кэш-БД с PG (`docs/specs/update.md`): три источника,
 * конкурентный фан-аут инстансов, пределы времени на каждое обращение,
 * запись одной транзакцией. Здесь же — точечный синк одного клиента:
 * та же машинерия, но выборки сужены до одного `client_id`, а запись —
 * upsert.
 *
 * Доступ к PG объявлен портом (`OpenPgSession`/`PgSession`) на стороне
 * потребителя: живого PostgreSQL в тестах нет, контрактные тесты
 * подставляют фейкового исполнителя. Драйвер (`pg.ts`) — единственная
 * реализация порта.
 */

import type { CacheDb } from "../command/mod.ts";
import { firstLine } from "../http/mod.ts";
import {
  type ClientRow,
  type PgRow,
  readClientRows,
  readSpreadsheetRows,
  readWbSidRows,
  type Snapshot,
  type SpreadsheetRow,
  upsertClient,
  type WbSidRow,
  writeSnapshot,
} from "./cache.ts";

/** Номер main-сервера: список клиентов и sid'ы живут только на нём. */
const MAIN_SERVER = 0;

/** Предел установления соединения с PG. */
export const CONNECT_TIMEOUT_MS = 5_000;

/** Предел одного запроса к PG. */
export const QUERY_TIMEOUT_MS = 20_000;

/**
 * Пределы PG-обращений. Оба обязательны: обращения, ждущего
 * неограниченно, не существует (инвариант спеки).
 */
export interface PgLimits {
  readonly connectMs: number;
  readonly queryMs: number;
}

/** Пределы по умолчанию; их числа названы в справке команды. */
export const DEFAULT_PG_LIMITS: PgLimits = {
  connectMs: CONNECT_TIMEOUT_MS,
  queryMs: QUERY_TIMEOUT_MS,
};

/**
 * Опции одной выборки. `signal` обязателен: по нему выборка обрывается
 * при исчерпании предела времени — реализация порта обязана его
 * соблюдать, иначе молчащий сервер задержит команду дольше предела.
 * `clientId` сужает выборку до одного клиента (точечный синк).
 */
export interface SelectOptions {
  readonly signal: AbortSignal;
  readonly clientId?: number;
}

/**
 * Read-only сессия к одному PG-серверу: три выборки спеки. Каждая —
 * либо по всему серверу, либо по одному клиенту.
 */
export interface PgSession {
  readonly clients: (options: SelectOptions) => Promise<readonly PgRow[]>;
  readonly spreadsheets: (options: SelectOptions) => Promise<readonly PgRow[]>;
  readonly wbSids: (options: SelectOptions) => Promise<readonly PgRow[]>;
  /** Закрывает соединение; зовётся всегда, в том числе после отмены. */
  readonly close: () => Promise<void>;
}

/** Открывает read-only сессию к серверу sl-N (N = 0 — main). */
export type OpenPgSession = (
  serverNumber: number,
  options: { readonly signal: AbortSignal },
) => Promise<PgSession>;

/** Предел времени PG-обращения исчерпан. */
class PgTimeoutError extends Error {
  override name = "PgTimeoutError";
}

/**
 * main (sl-0) недоступен: спека требует отказа команды без записи и
 * exit 1 — в отличие от сбоя инстанса, который только предупреждение.
 */
export class MainUnavailableError extends Error {
  override name = "MainUnavailableError";
}

/** Точечный синк: клиента нет в выборке main — отказ без записи. */
export class ClientNotFoundError extends Error {
  override name = "ClientNotFoundError";
}

/** Инстанс, обход которого не удался (подключение, запрос, таймаут). */
export interface FailedServer {
  readonly serverNumber: number;
  readonly reason: string;
}

/** Итог полного синка: счётчики записанного и упавшие инстансы. */
export interface SnapshotOutcome {
  readonly clients: number;
  readonly spreadsheets: number;
  readonly wbSids: number;
  /** Успешно опрошенные инстансы; упавшие не входят. */
  readonly servers: number;
  /** Упавшие инстансы по возрастанию номера. */
  readonly failed: readonly FailedServer[];
  readonly tookSeconds: number;
}

/** Общие зависимости синка: куда писать, чем ходить в PG и с чем. */
export interface SyncDeps {
  readonly db: CacheDb;
  readonly openPg: OpenPgSession;
  readonly limits?: PgLimits;
  /** Момент записи в unix-секундах; по умолчанию — текущее время. */
  readonly syncedAt?: number;
}

/**
 * Полный синк: список клиентов с main, таблицы клиентов с каждого
 * инстанса, sid'ы с main — полная перезапись снапшота. Печати здесь
 * нет: возможность вызывается и командой, и (позже) поиском в тихом
 * режиме, а строки собирает вызывающий из итога.
 *
 * Шаги 2 и 3 идут конкурентно, обход инстансов внутри шага 2 — тоже;
 * наблюдаемо это только временем (инвариант спеки), потому что состав
 * снапшота и порядок упавших серверов от порядка ответов не зависят.
 */
export async function syncSnapshot(deps: SyncDeps): Promise<SnapshotOutcome> {
  const limits = deps.limits ?? DEFAULT_PG_LIMITS;
  const started = performance.now();

  const main = await openMain(deps.openPg, limits);
  let clients: readonly ClientRow[];
  let instances: InstancesOutcome;
  let wbSids: readonly WbSidRow[];
  try {
    clients = readClientRows(await onMain(main.clients, {}, limits));
    // Шаг 3 идёт на той же сессии main, что и шаг 1, и одновременно с
    // фан-аутом шага 2. `allSettled`, а не `all`: отказ выборки sid'ов
    // при `all` бросил бы наружу, оставив обход инстансов висеть без
    // владельца.
    const [fanned, sids] = await Promise.allSettled([
      queryInstances(fanOutNumbers(clients), deps.openPg, limits),
      onMain(main.wbSids, {}, limits),
    ]);
    if (sids.status === "rejected") throw asMainFailure(sids.reason);
    // Обход инстансов отказом не завершается — сбой каждого он забирает
    // себе; проброс здесь нужен типам и ловит нарушение этого правила.
    if (fanned.status === "rejected") throw fanned.reason;
    instances = fanned.value;
    wbSids = readWbSidRows(sids.value, clients);
  } finally {
    await main.close();
  }

  const snapshot: Snapshot = {
    clients,
    spreadsheets: instances.rows,
    wbSids,
  };
  writeSnapshot(deps.db, snapshot, deps.syncedAt ?? nowSeconds());
  return {
    clients: clients.length,
    spreadsheets: instances.rows.length,
    wbSids: wbSids.length,
    servers: instances.servers,
    failed: instances.failed,
    tookSeconds: (performance.now() - started) / 1000,
  };
}

/** Итог точечного синка; `null` у части — она не выполнена. */
export interface ClientSyncOutcome {
  /** Строка `server` клиента, как её отдал main. */
  readonly server: string | null;
  readonly spreadsheets: number | null;
  readonly wbSids: number | null;
}

/**
 * Точечный синк одного клиента: три независимые best-effort части.
 * Клиента нет в выборке main — `ClientNotFoundError` и кэш не тронут;
 * сбой части 2 или 3 не мешает записать остальное.
 */
export async function syncClient(
  deps: SyncDeps & { readonly clientId: number },
): Promise<ClientSyncOutcome> {
  const limits = deps.limits ?? DEFAULT_PG_LIMITS;
  const { clientId } = deps;

  const main = await openMain(deps.openPg, limits);
  let client: ClientRow;
  let spreadsheets: readonly SpreadsheetRow[] | null;
  let wbSids: readonly WbSidRow[] | null;
  try {
    const found = readClientRows(
      await onMain(main.clients, { clientId }, limits),
    );
    if (found.length === 0) {
      throw new ClientNotFoundError(`клиент ${clientId} не найден`);
    }
    client = found[0];
    const serverNumber = fanOutNumberOf(client.server);
    const [ss, sids] = await Promise.allSettled([
      serverNumber === null
        // Сервер клиента не распознан или это main: его таблицы не
        // запрашиваются вовсе (инвариант «фан-аут — только N > 0»), а
        // часть 2 считается невыполненной.
        ? Promise.resolve(null)
        : clientSpreadsheets(serverNumber, clientId, deps.openPg, limits),
      select(main.wbSids, { clientId }, limits),
    ]);
    spreadsheets = ss.status === "fulfilled" && ss.value !== null
      ? readSpreadsheetRows(ss.value, client.server)
      : null;
    wbSids = sids.status === "fulfilled"
      ? readWbSidRows(sids.value, [client])
      : null;
  } finally {
    await main.close();
  }

  upsertClient(
    deps.db,
    { client, spreadsheets, wbSids },
    deps.syncedAt ?? nowSeconds(),
  );
  return {
    server: client.server,
    spreadsheets: spreadsheets === null ? null : spreadsheets.length,
    wbSids: wbSids === null ? null : wbSids.length,
  };
}

/**
 * Номера инстансов фан-аута по возрастанию, без повторов: из значений
 * `server` берётся `sl-(\d+)`, в фан-аут идут только N > 0 (main на
 * таблицы клиентов не опрашивается, нераспознанные значения не дают
 * номера вовсе).
 *
 * Возрастание задаётся здесь и наследуется всем, что дальше: строки
 * снапшота собираются в этом порядке, и в этом же порядке спека требует
 * перечислять упавшие серверы в предупреждении. Второй сортировки ниже
 * нет намеренно — порядок обязан иметь ровно одно место рождения.
 */
function fanOutNumbers(
  clients: readonly ClientRow[],
): readonly number[] {
  const numbers = new Set<number>();
  for (const client of clients) {
    const number = fanOutNumberOf(client.server);
    if (number !== null) numbers.add(number);
  }
  return [...numbers].sort((a, b) => a - b);
}

/** Номер инстанса фан-аута из строки `server`; не инстанс — `null`. */
function fanOutNumberOf(server: string | null): number | null {
  if (server === null) return null;
  const match = /sl-(\d+)/.exec(server);
  if (match === null) return null;
  const number = Number(match[1]);
  return number > 0 ? number : null;
}

/** Строки таблиц клиентов со всех инстансов плюс список упавших. */
interface InstancesOutcome {
  readonly rows: readonly SpreadsheetRow[];
  readonly failed: readonly FailedServer[];
  readonly servers: number;
}

/**
 * Конкурентный обход инстансов: сбой одного не мешает остальным и не
 * влияет на код выхода — сервер попадает в список упавших.
 */
async function queryInstances(
  numbers: readonly number[],
  open: OpenPgSession,
  limits: PgLimits,
): Promise<InstancesOutcome> {
  const outcomes = await Promise.allSettled(
    numbers.map((number) => instanceSpreadsheets(number, open, limits)),
  );
  const rows: SpreadsheetRow[] = [];
  const failed: FailedServer[] = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === "rejected") {
      failed.push({
        serverNumber: numbers[index],
        reason: reasonOf(outcome.reason),
      });
      return;
    }
    rows.push(...outcome.value);
  });
  // Ни строки, ни отказы не сортируются: `numbers` уже по возрастанию, а
  // `allSettled` сохраняет порядок задач независимо от порядка ответов —
  // конкурентность обхода остаётся ненаблюдаемой (инвариант спеки).
  return { rows, failed, servers: numbers.length - failed.length };
}

/** Таблицы клиентов с одного инстанса; имя сервера в строках — `sl-<N>`. */
async function instanceSpreadsheets(
  serverNumber: number,
  open: OpenPgSession,
  limits: PgLimits,
): Promise<readonly SpreadsheetRow[]> {
  const rows = await onInstance(serverNumber, {}, open, limits);
  return readSpreadsheetRows(rows, `sl-${serverNumber}`);
}

/** Таблицы одного клиента с его инстанса (часть 2 точечного синка). */
function clientSpreadsheets(
  serverNumber: number,
  clientId: number,
  open: OpenPgSession,
  limits: PgLimits,
): Promise<readonly PgRow[]> {
  return onInstance(serverNumber, { clientId }, open, limits);
}

/** Открыть инстанс, забрать таблицы клиентов, закрыть соединение. */
async function onInstance(
  serverNumber: number,
  narrow: { readonly clientId?: number },
  open: OpenPgSession,
  limits: PgLimits,
): Promise<readonly PgRow[]> {
  const session = await openSession(open, serverNumber, limits);
  try {
    return await select(session.spreadsheets, narrow, limits);
  } finally {
    await session.close();
  }
}

/** Открывает сессию main; отказ — `MainUnavailableError` (exit 1). */
async function openMain(
  open: OpenPgSession,
  limits: PgLimits,
): Promise<PgSession> {
  try {
    return await openSession(open, MAIN_SERVER, limits);
  } catch (err) {
    throw asMainFailure(err);
  }
}

/** Выборка на main; её отказ — отказ команды, а не деградация. */
async function onMain(
  run: (options: SelectOptions) => Promise<readonly PgRow[]>,
  narrow: { readonly clientId?: number },
  limits: PgLimits,
): Promise<readonly PgRow[]> {
  try {
    return await select(run, narrow, limits);
  } catch (err) {
    throw asMainFailure(err);
  }
}

function asMainFailure(err: unknown): MainUnavailableError {
  if (err instanceof MainUnavailableError) return err;
  return new MainUnavailableError(
    `main (sl-${MAIN_SERVER}) недоступен: ${reasonOf(err)}`,
    { cause: err },
  );
}

/** Открытие сессии под пределом установления соединения. */
function openSession(
  open: OpenPgSession,
  serverNumber: number,
  limits: PgLimits,
): Promise<PgSession> {
  return withDeadline(
    limits.connectMs,
    `нет соединения за ${limits.connectMs}ms`,
    (signal) => open(serverNumber, { signal }),
  );
}

/** Одна выборка под пределом запроса. */
function select(
  run: (options: SelectOptions) => Promise<readonly PgRow[]>,
  narrow: { readonly clientId?: number },
  limits: PgLimits,
): Promise<readonly PgRow[]> {
  return withDeadline(
    limits.queryMs,
    `нет ответа за ${limits.queryMs}ms`,
    (signal) => run({ signal, ...narrow }),
  );
}

/**
 * Ограничивает работу по времени: по истечении предела работе подаётся
 * сигнал отмены с `PgTimeoutError` в качестве причины, и она обязана
 * отказать этой же ошибкой. Гонки промисов здесь нет намеренно —
 * победивший в гонке предел оставил бы соединение открытым и без
 * владельца; вместо этого отменяемую работу обрывает её собственный
 * сигнал (`ts/CLAUDE.md`, «Асинхронность»). Таймер снимается всегда.
 */
async function withDeadline<T>(
  ms: number,
  message: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new PgTimeoutError(message)),
    ms,
  );
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Причина отказа одной строкой: многострочные сообщения PG режутся. */
function reasonOf(err: unknown): string {
  return firstLine(err instanceof Error ? err.message : String(err));
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
