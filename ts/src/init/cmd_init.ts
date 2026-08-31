/**
 * Команда `mpu init` (`docs/specs/init.md`) целиком: bootstrap схемы
 * кэш-БД, discovery контейнеров через Portainer, прогрев кэшей Loki и
 * Kaiten, вход в Telegram той же реализацией, что у команды.
 *
 * Модель исполнения — из спеки: шаг 1 первым; шаги 2–4 идут
 * конкурентно; шаг 5 (единственный интерактивный) — строго после них.
 * Порядок блоков вывода фиксирован (1…5) и не зависит от порядка
 * завершения, потому что во время конкурентной фазы не печатается
 * ничего: сбор возвращает данные, а строки рождаются уже в
 * последовательной фазе записи. Отдельная очередь строк для этого не
 * нужна — её роль играют сами результаты шагов.
 *
 * Служебные строки уходят не печатью, а в порт `io.progress`; печатает
 * их точка входа в stderr. Инвариант 1 контракта команд
 * (`platform/command-contract.md`: вывод, не являющийся проекцией
 * результата, доставляется портом io) этим не нарушен.
 */

import { z } from "@zod/zod";
import {
  type CacheDb,
  type CommandIo,
  defineCommand,
  DomainError,
  UsageError,
} from "../command/mod.ts";
import {
  DEFAULT_TIMEOUTS,
  firstLine,
  HEADERS_TIMEOUT_MS,
  type RequestTimeouts,
  TOTAL_TIMEOUT_MS,
} from "../http/mod.ts";
import {
  listContainers,
  listEndpoints,
  type PortainerAccess,
  type PortainerEndpoint,
} from "../portainer/mod.ts";
import { classifyContainer } from "./discovery.ts";
import {
  collectLokiSeries,
  type LokiSeries,
  requireLokiAccess,
  writeLokiCache,
} from "../loki/mod.ts";
import {
  collectKaitenWarmup,
  type KaitenWarmup,
  requireKaitenAccess,
  WARMUP_BUDGET_MS,
  writeKaitenWarmup,
} from "../kaiten/mod.ts";
import { runTelegramLogin, type TelegramIo } from "./telegram.ts";

/**
 * Пределы одного прогона. Числа названы в `--help` (инвариант спеки:
 * значения выбирает реализация, но пользователь обязан их видеть).
 */
export interface InitLimits {
  readonly timeouts: RequestTimeouts;
  /** Бюджет шага 4: паузы retry 429 его не отменяют (`init.md`). */
  readonly budgetMs: number;
}

/** Пределы по умолчанию; их и подставляет объявление команды. */
export const DEFAULT_INIT_LIMITS: InitLimits = {
  timeouts: DEFAULT_TIMEOUTS,
  budgetMs: WARMUP_BUDGET_MS,
};

const argsSchema = z.object({
  portainer: z.string().optional().describe(
    "базовый URL Portainer API; без флага — PORTAINER_URL в env-файле",
  ),
  "dry-run": z.boolean().default(false).describe(
    "только сводка шага 2: кэш не изменяется, шаги 3–5 не выполняются",
  ),
  reset: z.boolean().default(false).describe(
    "перед записью удалить весь прежний кэш контейнеров",
  ),
});

/** Счётчик части прогрева; `null` печатается в сводке как `?`. */
const countSchema = z.number().int().nullable();

const resultSchema = z.object({
  /** Базовый URL Portainer после нормализации (без хвостовых `/`). */
  portainerUrl: z.string(),
  /** sl-N контейнеры, найденные обходом, по возрастанию server_number. */
  containers: z.array(z.object({
    serverNumber: z.number().int(),
    containerName: z.string(),
    state: z.string(),
    endpointId: z.number().int(),
    endpointName: z.string(),
  })),
  /** Контейнеры без sl-номера, найденные тем же обходом. */
  otherCount: z.number().int(),
  /** Итог `--reset`; null — флаг не задан либо сработал `--dry-run`. */
  reset: z.object({ deleted: z.number().int() }).nullable(),
  /** Итог записи в кэш-БД; null означает `--dry-run` (кэш не тронут). */
  write: z.object({
    written: z.number().int(),
    cacheDbPath: z.string(),
  }).nullable(),
  /** Итог шага 3; null — шаг не выполнялся (`--dry-run`). */
  loki: z.object({
    /** Причина пропуска шага; null — шаг отработал. */
    skipped: z.string().nullable(),
    hosts: countSchema,
    pairs: countSchema,
  }).nullable(),
  /** Итог шага 4; null — шаг не выполнялся (`--dry-run`). */
  kaiten: z.object({
    skipped: z.string().nullable(),
    spaces: countSchema,
    boards: countSchema,
    lanes: countSchema,
    columns: countSchema,
    roles: countSchema,
    /** Доски, пропущенные в частях 2–3, по возрастанию id. */
    skippedBoards: z.array(z.object({
      boardId: z.number().int(),
      reason: z.string(),
    })),
  }).nullable(),
  /** Итог шага 5; null — шаг не выполнялся (`--dry-run`). */
  telegram: z.object({ skipped: z.string().nullable() }).nullable(),
});

/** Разобранные аргументы `mpu init`. */
export type InitArgs = z.infer<typeof argsSchema>;

/** Результат прогона: из него рендерится сводка stdout. */
export type InitResult = z.infer<typeof resultSchema>;

/** Строка кэша контейнеров (`portainer_containers`, `platform/store.md`). */
interface ContainerRow {
  readonly portainerUrl: string;
  readonly endpointId: number;
  readonly endpointName: string;
  readonly containerId: string;
  readonly containerName: string;
  readonly serverNumber: number | null;
  readonly state: string;
  readonly image: string;
  readonly discoveredAt: number;
}

/** Строка с уже известным номером sl-сервера — сужение `ContainerRow`. */
interface SlContainerRow extends ContainerRow {
  readonly serverNumber: number;
}

function hasServerNumber(row: ContainerRow): row is SlContainerRow {
  return row.serverNumber !== null;
}

/**
 * Upsert текущей находки — вторая половина записи шага 2, первая
 * (`reconcileContainerCache` ниже) чистит то, что Portainer больше не
 * подтверждает (`init.md`, шаг 2, «fix»). Обе идут в одной транзакции с
 * записью.
 */
const UPSERT_CONTAINER_SQL = `
  INSERT INTO portainer_containers (portainer_url, endpoint_id, endpoint_name,
    container_id, container_name, server_number, state, image, discovered_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(portainer_url, endpoint_id, container_id) DO UPDATE SET
    endpoint_name = excluded.endpoint_name,
    container_name = excluded.container_name,
    server_number = excluded.server_number,
    state = excluded.state,
    image = excluded.image,
    discovered_at = excluded.discovered_at
`;

/** `IN (?, ?, …)` на `n` параметров; вызывающий сам решает про `n === 0`. */
function placeholders(n: number): string {
  return Array(n).fill("?").join(", ");
}

/**
 * Реконсиляция кэша авторитетными данными оркестратора (`init.md`,
 * шаг 2, «fix»): в рамках `portainerUrl` удаляет down-endpoint'ы, записи
 * endpoint'ов вне только что полученного списка и контейнеры, пропавшие
 * с endpoint'а из `containerIdsByEndpoint`. Ключ этой карты и есть узкая
 * форма прежней осторожности — endpoint, чей обход сорвался, в неё не
 * попадает, и эта функция его записи не трогает вовсе.
 */
function reconcileContainerCache(
  db: CacheDb,
  portainerUrl: string,
  downEndpointIds: readonly number[],
  listedEndpointIds: readonly number[],
  containerIdsByEndpoint: ReadonlyMap<number, ReadonlySet<string>>,
): number {
  let deleted = deleteEndpoints(db, portainerUrl, downEndpointIds);
  deleted += deleteEndpointsNotListed(db, portainerUrl, listedEndpointIds);
  for (const [endpointId, containerIds] of containerIdsByEndpoint) {
    deleted += deleteMissingContainers(
      db,
      portainerUrl,
      endpointId,
      containerIds,
    );
  }
  return deleted;
}

/** Удаляет все записи перечисленных endpoint'ов (down-набор). */
function deleteEndpoints(
  db: CacheDb,
  portainerUrl: string,
  endpointIds: readonly number[],
): number {
  if (endpointIds.length === 0) return 0;
  return db.execute(
    `DELETE FROM portainer_containers WHERE portainer_url = ? AND ` +
      `endpoint_id IN (${placeholders(endpointIds.length)})`,
    portainerUrl,
    ...endpointIds,
  );
}

/**
 * Удаляет записи endpoint'ов, отсутствующих в `listedEndpointIds`. Пустой
 * список сюда не доходит: если ни один endpoint не дал ни одной строки,
 * команда обрывается раньше на «ни одного контейнера не найдено»
 * (`rows.length === 0` выше) — а значит, и `endpoints`, откуда собран
 * этот список, на момент вызова всегда непуст.
 */
function deleteEndpointsNotListed(
  db: CacheDb,
  portainerUrl: string,
  listedEndpointIds: readonly number[],
): number {
  return db.execute(
    `DELETE FROM portainer_containers WHERE portainer_url = ? AND ` +
      `endpoint_id NOT IN (${placeholders(listedEndpointIds.length)})`,
    portainerUrl,
    ...listedEndpointIds,
  );
}

/** Удаляет на одном endpoint'е контейнеры, отсутствующие в `currentContainerIds`. */
function deleteMissingContainers(
  db: CacheDb,
  portainerUrl: string,
  endpointId: number,
  currentContainerIds: ReadonlySet<string>,
): number {
  if (currentContainerIds.size === 0) {
    return db.execute(
      "DELETE FROM portainer_containers WHERE portainer_url = ? AND endpoint_id = ?",
      portainerUrl,
      endpointId,
    );
  }
  return db.execute(
    `DELETE FROM portainer_containers WHERE portainer_url = ? AND ` +
      `endpoint_id = ? AND container_id NOT IN (${
        placeholders(currentContainerIds.size)
      })`,
    portainerUrl,
    endpointId,
    ...currentContainerIds,
  );
}

/** Endpoint, обход которого завершился отказом (таймаут в т.ч.). */
interface EndpointFailure {
  readonly id: number;
  readonly name: string;
  readonly reason: string;
}

/** Итог разбора параллельного обхода endpoint'ов шага 2. */
interface ContainerScan {
  /** Найденные контейнеры всех endpoint'ов, обход которых не сорвался. */
  readonly rows: readonly ContainerRow[];
  /** Endpoint'ы, обход которых завершился отказом (таймаут в т.ч.). */
  readonly failures: readonly EndpointFailure[];
  /**
   * Id найденных контейнеров по endpoint'у — только для endpoint'ов,
   * чей обход успешно завершился (см. `scanContainers`).
   */
  readonly containerIdsByEndpoint: ReadonlyMap<number, ReadonlySet<string>>;
}

/**
 * Запрашивает список endpoints Portainer и переводит сетевой отказ в
 * `DomainError` с префиксом `portainer:` (`init.md`, шаг 2).
 */
async function fetchEndpoints(
  access: PortainerAccess,
  timeouts: RequestTimeouts,
): Promise<readonly PortainerEndpoint[]> {
  try {
    return await listEndpoints(access, timeouts);
  } catch (err) {
    throw new DomainError(`portainer: ${reasonOf(err)}`, { cause: err });
  }
}

/**
 * Разбирает исходы `Promise.allSettled` обхода endpoint'ов в единый
 * снимок: строки кэша, отказавшие endpoint'ы и карту id контейнеров по
 * endpoint'у. Endpoint'ы, обход которых успешно завершился, — ключ карты
 * и есть узкая форма прежней осторожности: реконсиляция кэша ниже
 * трогает только эти endpoint'ы, сорвавшийся обход в карту не попадает
 * (`init.md`, шаг 2).
 */
function scanContainers(
  outcomes: readonly PromiseSettledResult<
    Awaited<ReturnType<typeof listContainers>>
  >[],
  upEndpoints: readonly PortainerEndpoint[],
  portainerUrl: string,
  discoveredAt: number,
): ContainerScan {
  const failures: EndpointFailure[] = [];
  const rows: ContainerRow[] = [];
  const containerIdsByEndpoint = new Map<number, ReadonlySet<string>>();
  outcomes.forEach((outcome, index) => {
    const endpoint = upEndpoints[index];
    const found = scanEndpoint(outcome, endpoint, portainerUrl, discoveredAt);
    if (!found.ok) {
      failures.push(found.failure);
      return;
    }
    rows.push(...found.rows);
    containerIdsByEndpoint.set(endpoint.id, found.containerIds);
  });
  return { rows, failures, containerIdsByEndpoint };
}

/** Итог обхода одного endpoint'а: отказ либо найденные строки и id контейнеров. */
type EndpointScan =
  | { readonly ok: false; readonly failure: EndpointFailure }
  | {
    readonly ok: true;
    readonly rows: readonly ContainerRow[];
    readonly containerIds: ReadonlySet<string>;
  };

/**
 * Классифицирует находки одного endpoint'а в строки кэша. Вынесено из
 * `scanContainers` не ради имени: со вложенным разбором та выходит за
 * предел длины, а сам разбор — единственное место, где отказ обхода и
 * его находки различаются, поэтому у него свой union.
 */
function scanEndpoint(
  outcome: PromiseSettledResult<Awaited<ReturnType<typeof listContainers>>>,
  endpoint: PortainerEndpoint,
  portainerUrl: string,
  discoveredAt: number,
): EndpointScan {
  if (outcome.status === "rejected") {
    return {
      ok: false,
      failure: {
        id: endpoint.id,
        name: endpoint.name,
        reason: reasonOf(outcome.reason),
      },
    };
  }
  const containerIds = new Set<string>();
  const rows: ContainerRow[] = [];
  for (const container of outcome.value) {
    const classified = classifyContainer(container.names);
    rows.push({
      portainerUrl,
      endpointId: endpoint.id,
      endpointName: endpoint.name,
      containerId: container.id,
      containerName: classified.containerName,
      serverNumber: classified.serverNumber,
      state: container.state,
      image: container.image,
      discoveredAt,
    });
    containerIds.add(container.id);
  }
  return { ok: true, rows, containerIds };
}

/**
 * Печатает заметки о недошедших до кэша endpoint'ах — пропущенных
 * down-endpoint'ах и сорвавшихся обходах, объединённые в один блок и
 * отсортированные по возрастанию id. Порядок вывода детерминирован
 * независимо от того, какой endpoint ответил первым (конкурентность
 * ненаблюдаема — инвариант спеки).
 */
function printEndpointNotes(
  downEndpoints: readonly PortainerEndpoint[],
  failures: readonly EndpointFailure[],
  progress: (line: string) => void,
): void {
  const endpointNotes = [
    ...downEndpoints.map((e) => ({
      id: e.id,
      line: `mpu init: endpoint ${e.id} (${e.name}): down — пропущен`,
    })),
    ...failures.map((f) => ({
      id: f.id,
      line: `mpu init: endpoint ${f.id} (${f.name}): ${f.reason}`,
    })),
  ].sort((a, b) => a.id - b.id);
  for (const note of endpointNotes) progress(note.line);
}

/** Параметры записи находок шага 2 в кэш-БД одной транзакцией. */
interface WriteContainerCacheParams {
  readonly db: CacheDb;
  readonly portainerUrl: string;
  /** `--reset`: перед записью удалить весь прежний кэш контейнеров. */
  readonly reset: boolean;
  readonly rows: readonly ContainerRow[];
  readonly downEndpointIds: readonly number[];
  readonly listedEndpointIds: readonly number[];
  readonly containerIdsByEndpoint: ReadonlyMap<number, ReadonlySet<string>>;
}

/**
 * Пишет находки шага 2 в кэш-БД одной транзакцией (DELETE при `--reset`,
 * реконсиляция, upsert — сбой строки посреди записи откатывает всё
 * разом) и печатает итоговые строки строго после успешного коммита:
 * анонсировать удаление, которое ещё могло откатиться вместе с упавшим
 * upsert'ом, нельзя (`init.md`, шаг 2).
 */
function writeContainerCache(
  params: WriteContainerCacheParams,
  progress: (line: string) => void,
): { reset: { deleted: number } | null; write: InitResult["write"] } {
  const outcome = runContainerTransaction(params);
  const write = { written: params.rows.length, cacheDbPath: params.db.path };
  if (outcome.reset !== null) {
    progress(`# --reset: удалено ${outcome.reset.deleted} старых записей`);
  }
  if (outcome.reconciled > 0) {
    progress(`# удалено устаревших записей: ${outcome.reconciled}`);
  }
  progress(`# записано ${write.written} контейнеров в ${write.cacheDbPath}`);
  return { reset: outcome.reset, write };
}

/**
 * DELETE (`--reset`), реконсиляция и upsert находок шага 2 — одна
 * транзакция: сбой строки посреди записи откатывает всё разом, а не
 * фиксирует часть удалений отдельно от упавшего upsert'а.
 */
function runContainerTransaction(
  params: WriteContainerCacheParams,
): { reset: { deleted: number } | null; reconciled: number } {
  let reset: { deleted: number } | null = null;
  let reconciled = 0;
  params.db.transaction(() => {
    if (params.reset) {
      reset = {
        deleted: params.db.execute("DELETE FROM portainer_containers"),
      };
    }
    reconciled = reconcileContainerCache(
      params.db,
      params.portainerUrl,
      params.downEndpointIds,
      params.listedEndpointIds,
      params.containerIdsByEndpoint,
    );
    for (const row of params.rows) {
      params.db.execute(
        UPSERT_CONTAINER_SQL,
        row.portainerUrl,
        row.endpointId,
        row.endpointName,
        row.containerId,
        row.containerName,
        row.serverNumber,
        row.state,
        row.image,
        row.discoveredAt,
      );
    }
  });
  return { reset, reconciled };
}

export const initCommand = defineCommand({
  path: ["init"],
  summary: "первичная инициализация локальной кэш-БД: пять шагов",
  usage: "mpu init [--portainer TEXT] [--dry-run] [--reset]",
  help: `Пять шагов: 1) схема кэш-БД; 2) discovery контейнеров через
Portainer; 3) прогрев кэша Loki; 4) прогрев справочников Kaiten;
5) вход в Telegram (та же реализация, что у mpu telegram login). Шаг 1 первым,
2-4 конкурентно, 5 после них; блоки вывода — всегда в порядке 1..5.

Ключи env-файла ~/.config/mpu/.env (окружение процесса не читается):
PORTAINER_API_KEY, PORTAINER_URL (или --portainer),
PORTAINER_VERIFY_TLS (=true без учёта регистра включает проверку
TLS-сертификата, иначе выключена), LOKI_URL, KITEN_API_KEY,
KITEN_BASE_URL.

Пределы вызова: ${HEADERS_TIMEOUT_MS} ms до заголовков, ${TOTAL_TIMEOUT_MS} ms целиком;
бюджет прогрева Kaiten ${WARMUP_BUDGET_MS} ms (паузы retry 429 его не
отменяют; исчерпан — счётчик части «?»).

Шаги 3-5 best-effort: пропуск виден строкой «# <шаг>: пропущено
(<причина>)» и кода выхода не меняет. Контейнеры пишутся upsert'ом по
(portainer_url, endpoint_id, container_id); запись реконсилирует кэш
(down-endpoint'ы, пропавшие endpoint'ы/контейнеры удаляются, кроме
сорвавшегося обхода); --reset чистит весь кэш заранее. --dry-run:
только сводка шага 2, кэш не тронут (схема шага 1 создаётся всегда),
шаги 3-5 не идут.

Exit: 0 — успех; 2 — нет PORTAINER_API_KEY/URL либо URL без схемы;
1 — сбой списка endpoints либо ни одного контейнера.

Пример: mpu init --portainer https://portainer.example.com`,
  policy: "rw",
  argsSchema,
  resultSchema,
  run: (args, io) => runInit(args, io),
  render: (result) => {
    const lines: string[] = [
      `# найдено sl-N контейнеров: ${result.containers.length}\n`,
    ];
    for (const c of result.containers) {
      lines.push(
        `sl-${c.serverNumber}: ${c.containerName} [${c.state}] @ endpoint ` +
          `${c.endpointId} (${c.endpointName}) -> ${result.portainerUrl}/${c.endpointId}\n`,
      );
    }
    lines.push(`# прочих контейнеров: ${result.otherCount}\n`);
    return lines.join("");
  },
});

/**
 * Срез порта исполнения, который потребляет команда: env-файл (доступ к
 * Portainer, Loki и Kaiten), кэш-БД стенда, строка хода и — шагом
 * входа в Telegram — терминал для вопросов пользователю.
 */
type InitIo =
  & Pick<CommandIo, "envFile" | "openCacheDb" | "progress">
  & TelegramIo;

/**
 * Все пять шагов. Вынесено из объявления команды по двум причинам:
 * тело длиннее экрана, и пределы вызовов здесь — параметр со значением
 * по умолчанию. Параметр нужен тестам молчащего источника: без него
 * тест ждал бы реальные секунды продуктовых пределов, а сон стеной в
 * тестах запрещён (`ts/CLAUDE.md`). Команда зовёт эту функцию с
 * умолчанием, то есть вызова без предела по-прежнему не существует.
 */
export async function runInit(
  args: InitArgs,
  io: InitIo,
  limits: InitLimits = DEFAULT_INIT_LIMITS,
): Promise<InitResult> {
  using db = io.openCacheDb();
  db.bootstrap();
  io.progress(`# bootstrap: схема в ${db.path} готова`);

  const access = requirePortainerAccess(args, io.envFile);
  const endpoints = await fetchEndpoints(access, limits.timeouts);

  // Прогревы не запускаются при `--dry-run` и не запускаются раньше,
  // чем список endpoints получен: сбой этого списка обрывает команду, а
  // спека требует, чтобы шаги 3–5 при таком обрыве не выполнялись.
  const warm = !args["dry-run"];
  const discoveredAt = Math.floor(Date.now() / 1000);
  const scan = await discoverContainers(
    access,
    endpoints,
    limits,
    warm,
    discoveredAt,
    io,
  );
  if (scan.rows.length === 0) {
    throw new DomainError("ни одного контейнера не найдено");
  }

  const outcome = persistContainers(
    db,
    args,
    access.baseUrl,
    endpoints,
    scan,
    io.progress,
  );
  const warmups = await applyWarmupSteps(db, io, scan, discoveredAt, warm);
  return buildInitResult(access.baseUrl, scan.rows, outcome, warmups);
}

/** Итоги прогревов — шаги 3, 4 и 5 (`init.md`), каждый в своём поле. */
interface WarmupResults {
  readonly loki: InitResult["loki"];
  readonly kaiten: InitResult["kaiten"];
  readonly telegram: InitResult["telegram"];
}

/**
 * Записывает собранное шагами 3–4 и выполняет шаг 5. Блоки 3, 4 и 5 —
 * строго в этом порядке и строго после блока 2: запись и печать идут
 * здесь, последовательно, а не там, где шаги собирали данные. Вызовы
 * вынесены из литерала результата намеренно — у каждого есть побочный
 * эффект, и порядок эффектов должен читаться из кода, а не из порядка
 * полей объекта.
 */
async function applyWarmupSteps(
  db: CacheDb,
  io: InitIo,
  scan: DiscoveryOutcome,
  discoveredAt: number,
  warm: boolean,
): Promise<WarmupResults> {
  const loki = applyLoki(db, io, scan.loki, discoveredAt);
  const kaiten = applyKaiten(db, io, scan.kaiten, discoveredAt);
  const telegram = warm ? await applyTelegram(io) : null;
  return { loki, kaiten, telegram };
}

/**
 * Пишет находки шага 2 в кэш-БД, если это не `--dry-run` (`init.md`,
 * шаг 2); при `--dry-run` кэш не тронут вовсе, и функция возвращает
 * пустой итог без обращения к `db`.
 */
function persistContainers(
  db: CacheDb,
  args: InitArgs,
  portainerUrl: string,
  endpoints: readonly PortainerEndpoint[],
  scan: DiscoveryOutcome,
  progress: (line: string) => void,
): { reset: { deleted: number } | null; write: InitResult["write"] } {
  if (args["dry-run"]) return { reset: null, write: null };
  return writeContainerCache({
    db,
    portainerUrl,
    reset: args.reset,
    rows: scan.rows,
    downEndpointIds: scan.downEndpoints.map((e) => e.id),
    listedEndpointIds: endpoints.map((e) => e.id),
    containerIdsByEndpoint: scan.containerIdsByEndpoint,
  }, progress);
}

/** Собирает итоговый `InitResult` из результатов всех пяти шагов. */
function buildInitResult(
  portainerUrl: string,
  rows: readonly ContainerRow[],
  outcome: { reset: InitResult["reset"]; write: InitResult["write"] },
  warmups: WarmupResults,
): InitResult {
  const slRows = rows.filter(hasServerNumber).sort((a, b) =>
    a.serverNumber - b.serverNumber
  );
  return {
    portainerUrl,
    containers: slRows.map((row) => ({
      serverNumber: row.serverNumber,
      containerName: row.containerName,
      state: row.state,
      endpointId: row.endpointId,
      endpointName: row.endpointName,
    })),
    otherCount: rows.length - slRows.length,
    reset: outcome.reset,
    write: outcome.write,
    loki: warmups.loki,
    kaiten: warmups.kaiten,
    telegram: warmups.telegram,
  };
}

/** Итог конкурентного обхода endpoint'ов и best-effort прогревов шагов 3–4. */
interface DiscoveryOutcome {
  /** Найденные контейнеры всех endpoint'ов, обход которых не сорвался. */
  readonly rows: readonly ContainerRow[];
  /** Endpoint'ы со `status` ≠ 1 — не опрошены вовсе (см. `discoverContainers`). */
  readonly downEndpoints: readonly PortainerEndpoint[];
  readonly containerIdsByEndpoint: ReadonlyMap<number, ReadonlySet<string>>;
  /** Итог шага 3; `null` — прогрев не запускался (`--dry-run`). */
  readonly loki: LokiStep | null;
  /** Итог шага 4; `null` — прогрев не запускался (`--dry-run`). */
  readonly kaiten: KaitenStep | null;
}

/**
 * Шаг 2 целиком (обход + разбор) конкурентно с best-effort прогревами
 * шагов 3–4 (`init.md`): один `Promise.all` на все три источника сети.
 * Down-endpoint (`Status` ≠ 1) не опрашивается вовсе — его таймаут не
 * тратится, а строка пропуска не ждёт сети. Заметки о недошедших до
 * кэша endpoint'ах печатаются здесь же, до записи: конкурентная фаза
 * ничего больше не печатает, поэтому порядок вывода не зависит от того,
 * кто из трёх источников ответил первым.
 */
async function discoverContainers(
  access: PortainerAccess,
  endpoints: readonly PortainerEndpoint[],
  limits: InitLimits,
  warm: boolean,
  discoveredAt: number,
  io: InitIo,
): Promise<DiscoveryOutcome> {
  const upEndpoints = endpoints.filter((e) => e.status === 1);
  const downEndpoints = endpoints.filter((e) => e.status !== 1);

  const [outcomes, loki, kaiten] = await Promise.all([
    Promise.allSettled(
      upEndpoints.map((endpoint) =>
        listContainers(access, endpoint.id, limits.timeouts)
      ),
    ),
    warm ? collectLoki(io, limits) : Promise.resolve(null),
    warm ? collectKaiten(io, limits) : Promise.resolve(null),
  ]);

  const { rows, failures, containerIdsByEndpoint } = scanContainers(
    outcomes,
    upEndpoints,
    access.baseUrl,
    discoveredAt,
  );
  printEndpointNotes(downEndpoints, failures, io.progress);

  return { rows, downEndpoints, containerIdsByEndpoint, loki, kaiten };
}

/** Собранное шагом 3 либо причина, по которой собрать не вышло. */
type LokiStep =
  | { readonly ok: true; readonly series: LokiSeries }
  | { readonly ok: false; readonly reason: string };

/** Собранное шагом 4 либо причина отказа части 1 или конфигурации. */
type KaitenStep =
  | { readonly ok: true; readonly warmup: KaitenWarmup }
  | { readonly ok: false; readonly reason: string };

/**
 * Шаг 3 без записи: только сеть. Печати здесь нет — иначе строка ушла
 * бы в поток посреди конкурентной фазы и порядок блоков зависел бы от
 * того, кто ответил первым.
 */
async function collectLoki(
  io: InitIo,
  limits: InitLimits,
): Promise<LokiStep> {
  try {
    const access = requireLokiAccess(io.envFile);
    return {
      ok: true,
      series: await collectLokiSeries(access, limits.timeouts),
    };
  } catch (err) {
    return { ok: false, reason: reasonOf(err) };
  }
}

/** Шаг 4 без записи: только сеть (см. `collectLoki`). */
async function collectKaiten(
  io: InitIo,
  limits: InitLimits,
): Promise<KaitenStep> {
  try {
    const access = requireKaitenAccess(io.envFile);
    return {
      ok: true,
      warmup: await collectKaitenWarmup(access, {
        timeouts: limits.timeouts,
        budgetMs: limits.budgetMs,
      }),
    };
  } catch (err) {
    return { ok: false, reason: reasonOf(err) };
  }
}

/** Запись шага 3 и его строка сводки; шаг не выполнялся — `null`. */
function applyLoki(
  db: CacheDb,
  io: InitIo,
  step: LokiStep | null,
  discoveredAt: number,
): InitResult["loki"] {
  if (step === null) return null;
  if (!step.ok) {
    io.progress(`# loki: пропущено (${step.reason})`);
    return { skipped: step.reason, hosts: null, pairs: null };
  }
  const failed = writeOrReason(() =>
    writeLokiCache(db, step.series, discoveredAt)
  );
  if (failed !== null) {
    io.progress(`# loki: пропущено (${failed})`);
    return { skipped: failed, hosts: null, pairs: null };
  }
  const hosts = step.series.hosts.length;
  const pairs = step.series.pairs.length;
  io.progress(`# loki: ${hosts} hosts, ${pairs} (host, service) пар`);
  return { skipped: null, hosts, pairs };
}

/** Запись шага 4, строки пропусков досок и сводка; не выполнялся — `null`. */
function applyKaiten(
  db: CacheDb,
  io: InitIo,
  step: KaitenStep | null,
  discoveredAt: number,
): InitResult["kaiten"] {
  if (step === null) return null;
  const empty = {
    spaces: null,
    boards: null,
    lanes: null,
    columns: null,
    roles: null,
    skippedBoards: [],
  };
  if (!step.ok) {
    io.progress(`# kaiten: пропущено (${step.reason})`);
    return { skipped: step.reason, ...empty };
  }
  const warmup = step.warmup;
  const failed = writeOrReason(() =>
    writeKaitenWarmup(db, warmup, discoveredAt)
  );
  if (failed !== null) {
    io.progress(`# kaiten: пропущено (${failed})`);
    return { skipped: failed, ...empty };
  }
  // Строки атома (повторы 429) идут первыми: они рассказывают о том, что
  // происходило до сводки, и в ней самой следа не оставляют.
  for (const note of warmup.notes) io.progress(note);
  const skippedBoards = [...warmup.skips]
    .sort((a, b) => a.boardId - b.boardId)
    .map((skip) => ({ boardId: skip.boardId, reason: skip.reason }));
  for (const board of skippedBoards) {
    io.progress(
      `# kaiten: доска ${board.boardId}: пропущена (${board.reason})`,
    );
  }
  const counts = {
    spaces: warmup.spaces.length,
    boards: warmup.boards.length,
    lanes: warmup.lanes === null ? null : warmup.lanes.rows.length,
    columns: warmup.columns === null ? null : warmup.columns.rows.length,
    roles: warmup.roles === null ? null : warmup.roles.length,
  };
  io.progress(
    `# kaiten: ${counts.spaces} spaces, ${counts.boards} boards, ` +
      `${mark(counts.lanes)} lanes, ${mark(counts.columns)} columns, ` +
      `${mark(counts.roles)} roles`,
  );
  return { skipped: null, ...counts, skippedBoards };
}

/** Шаг 5: тот же вход, что у команды; его исход код выхода init не меняет. */
async function applyTelegram(
  io: InitIo,
): Promise<{ skipped: string | null }> {
  // Строку `# telegram: пропущено (<причина>)` печатает сам вход: с
  // порции 95 шаг зовёт его напрямую, и вторая печать здесь задвоила
  // бы её. Причина всё равно нужна — она уходит в результат команды.
  return { skipped: await runTelegramLogin(io) };
}

/**
 * Счётчик в сводке: `?` у части, упавшей целиком (`init.md`, шаг 4).
 * Ноль от `?` отличается — пустой справочник это не то же, что
 * неизвестный.
 */
function mark(count: number | null): string {
  return count === null ? "?" : String(count);
}

/**
 * Выполняет запись прогрева и возвращает причину её отказа. Сбой записи
 * best-effort шага обрывать команду не должен: спека называет пропуском
 * «любую ошибку» шага, а не только сетевую.
 */
function writeOrReason(write: () => void): string | null {
  try {
    write();
    return null;
  } catch (err) {
    return reasonOf(err);
  }
}

/**
 * Читает и проверяет конфигурацию Portainer (`docs/specs/init.md`,
 * шаг 2). Тексты ошибок — дословно из спеки: путь `~/.config/mpu/.env`
 * в них литерал, а не вычисленный путь env-файла (см. проект
 * реализации порции А). Экспортирована ради теста: приоритет
 * `--portainer` над `PORTAINER_URL` и чтение `PORTAINER_VERIFY_TLS`
 * иначе пришлось бы поднимать TLS-сервер только ради этих двух свойств.
 */
export function requirePortainerAccess(
  args: { readonly portainer?: string },
  envFile: { readonly get: (name: string) => string | undefined },
): PortainerAccess {
  const apiKey = envFile.get("PORTAINER_API_KEY");
  if (apiKey === undefined || apiKey === "") {
    throw new UsageError("в ~/.config/mpu/.env нет PORTAINER_API_KEY");
  }
  const rawUrl = args.portainer ?? envFile.get("PORTAINER_URL");
  if (rawUrl === undefined || rawUrl === "") {
    throw new UsageError(
      "укажите --portainer <url> либо PORTAINER_URL в ~/.config/mpu/.env",
    );
  }
  // Схема проверяется здесь, до какого-либо сетевого вызова: это ошибка
  // конфигурации, симметричная отсутствию URL (`init.md`, «Граничные
  // случаи»), а не сбой обращения к Portainer. Без проверки разбор
  // адреса падал бы английским `Invalid URL` уже внутри клиента и
  // приходил бы к пользователю как exit 1 вместо exit 2.
  if (!/^https?:\/\//i.test(rawUrl)) {
    throw new UsageError(
      `некорректный URL Portainer: '${rawUrl}' — нужна схема http:// или https://`,
    );
  }
  const verifyTls =
    envFile.get("PORTAINER_VERIFY_TLS")?.toLowerCase() === "true";
  return { baseUrl: rawUrl.replace(/\/+$/, ""), apiKey, verifyTls };
}

/** Причина ошибки одной строкой (вердикт fix спеки — см. `../http/mod.ts`). */
function reasonOf(err: unknown): string {
  return firstLine(err instanceof Error ? err.message : String(err));
}
