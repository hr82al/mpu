/**
 * Команда `mpu update` (`docs/specs/update.md`): полный синк снапшота
 * кэш-БД с PG и best-effort прогрев кэша Loki.
 *
 * Сама механика синка живёт в `sync.ts` — она вызывается и без CLI
 * (поиском, в тихом режиме). Здесь только то, что делает из неё
 * команду: аргументы, справка, строки вывода и коды выхода.
 */

import { z } from "@zod/zod";
import {
  type CacheDb,
  type CommandIo,
  defineCommand,
  DomainError,
} from "../command/mod.ts";
import {
  DEFAULT_TIMEOUTS,
  firstLine,
  type RequestTimeouts,
} from "../http/mod.ts";
import {
  collectLokiSeries,
  requireLokiAccess,
  writeLokiCache,
} from "../loki/mod.ts";
import {
  CONNECT_TIMEOUT_MS,
  DEFAULT_PG_LIMITS,
  type FailedServer,
  MainUnavailableError,
  type OpenPgSession,
  type PgLimits,
  QUERY_TIMEOUT_MS,
  type SnapshotOutcome,
  syncSnapshot,
} from "./sync.ts";

/** Пределы прогона: PG-обращения и запрос к Loki. */
export interface UpdateLimits {
  readonly pg: PgLimits;
  readonly loki: RequestTimeouts;
}

/** Пределы по умолчанию; их числа названы в справке. */
export const DEFAULT_UPDATE_LIMITS: UpdateLimits = {
  pg: DEFAULT_PG_LIMITS,
  loki: DEFAULT_TIMEOUTS,
};

const argsSchema = z.object({
  quiet: z.boolean().default(false).describe(
    "не печатать ничего: ни сводку, ни строку Loki, ни предупреждения",
  ),
});

const resultSchema = z.object({
  clients: z.number().int(),
  spreadsheets: z.number().int(),
  /** Успешно опрошенные инстансы; упавшие не входят. */
  servers: z.number().int(),
  wbSids: z.number().int(),
  /** Длительность синка PG-части в секундах. */
  tookSeconds: z.number(),
  /** Упавшие инстансы по возрастанию номера сервера. */
  failedServers: z.array(z.object({
    server: z.string(),
    reason: z.string(),
  })),
  /** Итог прогрева Loki; счётчики `null` — прогрев пропущен. */
  loki: z.object({
    skipped: z.string().nullable(),
    hosts: z.number().int().nullable(),
    pairs: z.number().int().nullable(),
  }),
});

/** Разобранные аргументы `mpu update`. */
export type UpdateArgs = z.infer<typeof argsSchema>;

/** Результат прогона: из него рендерится сводка stdout. */
export type UpdateResult = z.infer<typeof resultSchema>;

export const updateCommand = defineCommand({
  path: ["update"],
  summary: "синк снапшота кэш-БД с PG: клиенты, их таблицы, wb-sid'ы",
  usage: "mpu update [--quiet]",
  help: `Полная перезапись снапшота кэш-БД одной транзакцией: список
клиентов и wb-sid'ы — с main (sl-0), таблицы клиентов — с каждого
инстанса sl-N, названного в поле server. Затем best-effort прогрев
кэша Loki: его сбой на код выхода не влияет.

Ключи env-файла ~/.config/mpu/.env (окружение процесса не читается):
pg_<N> — адреса серверов; PG_PORT (5432), PG_DB_NAME (wb);
PG_MY_USER_NAME/PG_MAIN_USER_NAME и PG_MY_USER_PASSWORD/
PG_MAIN_USER_PASSWORD (личные приоритетнее общих); LOKI_URL.

Пределы PG-обращения: ${CONNECT_TIMEOUT_MS} ms на соединение, ${QUERY_TIMEOUT_MS} ms на запрос;
сессия открывается read-only. Инстансы опрашиваются конкурентно:
упавший даёт строку warning в stderr, в число серверов сводки не
входит и кода выхода не меняет.
Прогрев Loki: ${DEFAULT_TIMEOUTS.headersTimeoutMs} ms до заголовков, ${DEFAULT_TIMEOUTS.totalTimeoutMs} ms целиком.

--quiet подавляет весь вывод целиком; обращения и записи при этом
выполняются полностью.

Exit: 0 — успех, включая прогон с упавшими инстансами; 1 — недоступный
main (sl-0): кэш при этом не изменяется.

Пример: mpu update`,
  policy: "rw",
  argsSchema,
  resultSchema,
  run: (args, io) => runUpdate(args, io),
  render: (result, args) => {
    if (args.quiet) return "";
    const lines = [
      `clients: ${result.clients} rows, spreadsheets: ${result.spreadsheets} ` +
      `rows from ${result.servers} servers, wb sids: ${result.wbSids} rows, ` +
      `took ${result.tookSeconds.toFixed(2)}s\n`,
    ];
    if (result.loki.hosts !== null) {
      lines.push(
        `loki: ${result.loki.hosts} hosts, ${result.loki.pairs} (host, service) пар\n`,
      );
    }
    return lines.join("");
  },
});

/** Подмены для тестов: живого PG нет, а продуктовые пределы — секунды. */
export interface UpdateOptions {
  readonly openPg?: OpenPgSession;
  readonly limits?: UpdateLimits;
}

/**
 * Прогон команды. Вынесено из объявления ради двух подмен: исполнителя
 * PG-запросов (живого PostgreSQL в тестах нет) и пределов времени (по
 * умолчанию они секундные, и тест молчащего инстанса ждал бы их стеной).
 * Команда зовёт эту функцию без подмен — прогона без пределов не бывает.
 */
export async function runUpdate(
  args: UpdateArgs,
  io: CommandIo,
  options: UpdateOptions = {},
): Promise<UpdateResult> {
  const limits = options.limits ?? DEFAULT_UPDATE_LIMITS;
  const openPg = options.openPg ?? denoPgOpener(io, limits.pg);

  using db = io.openCacheDb();
  let outcome: SnapshotOutcome;
  try {
    outcome = await syncSnapshot({ db, openPg, limits: limits.pg });
  } catch (err) {
    // Недоступный main — отказ команды (exit 1) без записи; текст уже
    // назван спекой, префикс `mpu update:` добавит точка входа.
    if (err instanceof MainUnavailableError) {
      throw new DomainError(err.message, { cause: err });
    }
    throw err;
  }
  if (!args.quiet && outcome.failed.length > 0) {
    io.progress(warningLine(outcome.failed));
  }

  const loki = await warmLoki(db, io, args.quiet, limits.loki);
  return {
    clients: outcome.clients,
    spreadsheets: outcome.spreadsheets,
    servers: outcome.servers,
    wbSids: outcome.wbSids,
    tookSeconds: outcome.tookSeconds,
    failedServers: outcome.failed.map((failed) => ({
      server: `sl-${failed.serverNumber}`,
      reason: failed.reason,
    })),
    loki,
  };
}

/** Одна строка обо всех упавших инстансах, по возрастанию номера. */
function warningLine(failed: readonly FailedServer[]): string {
  const servers = failed
    .map((server) => `sl-${server.serverNumber} (${server.reason})`)
    .join(", ");
  return `warning: failed to query servers: ${servers}`;
}

/**
 * Прогрев кэша Loki (`platform/loki-http.md`). Best-effort и не зависит
 * от `--quiet`: тот подавляет только печать, а обращения и записи
 * выполняются полностью (спека, «Вывод»).
 */
async function warmLoki(
  db: CacheDb,
  io: CommandIo,
  quiet: boolean,
  timeouts: RequestTimeouts,
): Promise<UpdateResult["loki"]> {
  try {
    const series = await collectLokiSeries(
      requireLokiAccess(io.envFile),
      timeouts,
    );
    writeLokiCache(db, series, Math.floor(Date.now() / 1000));
    return {
      skipped: null,
      hosts: series.hosts.length,
      pairs: series.pairs.length,
    };
  } catch (err) {
    const reason = firstLine(err instanceof Error ? err.message : String(err));
    if (!quiet) io.progress(`loki: пропущено (${reason})`);
    return { skipped: reason, hosts: null, pairs: null };
  }
}

/**
 * Открыватель сессий поверх драйвера. Драйвер грузится динамически:
 * npm-пакет тяжёл, а нужен он одной команде — статический импорт
 * поднимал бы его на каждом запуске бинаря.
 */
function denoPgOpener(io: CommandIo, limits: PgLimits): OpenPgSession {
  return async (serverNumber, options) => {
    const { makePgOpener } = await import("./pg.ts");
    return await makePgOpener(io.envFile, limits)(serverNumber, options);
  };
}
