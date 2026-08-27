/**
 * Ход вызова ad-hoc SQL по селектору: аргументы, порядок шагов и
 * результат. Общее тело команд `mpu sql-ro` (`docs/specs/sql-ro.md`) и
 * `mpu sql` (`docs/specs/sql.md`) — контракт у них один, различий
 * четыре, и все они названы в спеке write-варианта.
 *
 * Формы вывода — `render.ts`, адрес и маршрут — `target.ts`, сама сессия
 * — порт `session.ts`.
 */

import { z } from "@zod/zod";
import {
  type CacheDb,
  type CommandIo,
  DomainError,
  readTextStdin,
  UsageError,
  VerbatimError,
} from "../command/mod.ts";
import { type CacheReader, resolveSelector } from "../selector/mod.ts";
import { type MetaBlock, metaText } from "./meta.ts";
import { type OutputFormat, type SqlOutcome } from "./render.ts";
import {
  DbError,
  type OpenSession,
  type SqlMode,
  type SqlSession,
  TransactionEndedError,
  WriteRefusedError,
} from "./session.ts";
import {
  devTarget,
  type PgTarget,
  routeOf,
  type SelectorRoute,
  serverTarget,
} from "./target.ts";

/**
 * Срез порта исполнения, который потребляет команда: env-файл (адреса и
 * секреты серверов), кэш-БД селектора, чтение SQL со stdin и служебная
 * строка хода.
 */
export type SqlIo = Pick<
  CommandIo,
  "envFile" | "openCacheDb" | "progress" | "readStdin" | "stdinIsTerminal"
>;

/**
 * Проверка того, что запрет записи действует на самом соединении, а не
 * предполагается по факту отправки опции (`platform/readonly-default.md`,
 * «Инварианты»). Цена — одно обращение на сессию, принята осознанно.
 */
const READ_ONLY_CHECK = "SELECT current_setting('transaction_read_only')";

/** Приглашение интерактивного ввода SQL; уходит в stderr. */
const PROMPT = "-- enter SQL, end with EOF (Ctrl+D):";

/** Отказ сервера пишущему запросу — текст спеки дословно. */
const WRITE_REFUSED = "запрос пытается писать — заблокировано read-only " +
  "сессией. Для записи используйте `mpu sql`.";

/**
 * Метку обёртки снять не удалось (`25P01`/`3B001`) — текст спеки
 * дословно. Тем же кодом `3B001` сервер отвечает и на ссылку самого
 * текста пользователя на не открывавшуюся точку сохранения при целой
 * транзакции вызова, поэтому формулировка не утверждает, что гарантия
 * снята — только что она не подтверждена (`platform/readonly-default.md`).
 */
const TRANSACTION_ENDED = "метка транзакции вызова не снята — гарантия " +
  "только-чтения не подтверждена, результат не печатается";

export const argsSchema = z.object({
  // Текст отсутствия — свой: голый `mpu sql-ro` спека завершает кодом 2,
  // и сообщение обязано называть, чего не хватает, а не показывать
  // формулировку схемы («expected string, received undefined»).
  selector: z.string({
    error: "нужен SELECTOR: client_id, sl-N, dev:<client_id> или sw-алиас",
  }).describe(
    "client_id / spreadsheet_id / заголовок (подстрока), sl-N, " +
      "dev:<client_id> или sw-алиас",
  ),
  sql: z.string().optional().describe(
    "SQL; не задан — читается из stdin",
  ),
  server: z.string().optional().describe("override резолва: sl-N"),
  dry: z.boolean().default(false).describe(
    "только мета-блок и SQL, без подключения",
  ),
  json: z.boolean().default(false).describe("результат как JSON"),
  md: z.boolean().default(false).describe("результат как markdown-таблица"),
  verbose: z.boolean().default(false).describe("печатать мета-блок"),
});

const outcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rows"),
    columns: z.array(z.string()).readonly(),
    rows: z.array(z.array(z.json()).readonly()).readonly(),
  }),
  z.object({ kind: z.literal("done"), rowcount: z.number().int() }),
]);

export const resultSchema = z.object({
  /** `sl-<N>` либо `dev`. */
  server: z.string(),
  host: z.string(),
  port: z.number().int(),
  database: z.string(),
  /** Схема клиента; search_path не ставился — null. */
  searchPath: z.string().nullable(),
  /** Текст, ушедший серверу, как введён. */
  sql: z.string(),
  /** Соединения не было: `--dry`. */
  dry: z.boolean(),
  /** Результат первого оператора; при `--dry` — null. */
  outcome: outcomeSchema.nullable(),
});

/** Разобранные аргументы вызова. */
export type SqlArgs = z.infer<typeof argsSchema>;

/** Результат вызова: из него рендерится stdout. */
export type SqlResult = z.infer<typeof resultSchema>;

/** Чем вызов `mpu sql` отличается от `mpu sql-ro` и шов для тестов. */
export interface SqlOptions {
  /**
   * Режим сессии: из него выводятся и опция подключения, и форма
   * транзакции, и строка `mode` мета-блока — второго источника этого
   * решения нет.
   */
  readonly mode: SqlMode;
  /** Подмена для тестов: живого PostgreSQL у них нет. */
  readonly openSession?: OpenSession;
}

/**
 * Прогон команды. Вынесено из объявления ради подмены открывателя
 * сессии; команды зовут эту функцию без подмен.
 */
export async function runSql(
  args: SqlArgs,
  io: SqlIo,
  options: SqlOptions,
): Promise<SqlResult> {
  // Первым делом, до чтения SQL и до резолва (спека): иначе конфликт
  // флагов вскрылся бы после приглашения ко вводу.
  if (args.json && args.md) {
    throw new UsageError("--json и --md взаимоисключающие");
  }
  const route = routeOf(args.selector);
  if (route.kind === "sw") {
    // CLI сюда не доходит — вызов уводит `bridge` до разбора аргументов.
    // Остаётся точка входа MCP, где подпроцесса с проброшенными потоками
    // нет вовсе (`platform/mcp-server.md`).
    throw new DomainError(
      "sw-селектор исполняет прежняя реализация: вызов доступен только из CLI",
    );
  }
  if (route.kind === "dev" && args.server !== undefined) {
    throw new UsageError("--server не сочетается с dev-селектором");
  }
  const place = placeOf(route, args, io);
  const sql = await readSql(args, io);
  if (sql.trim() === "") throw new UsageError("empty SQL");
  // Одна раскладка на мета-блок и на результат: поля у них те же, а
  // креды остаются в `place.target` и наружу не выходят.
  const shown: MetaBlock = {
    server: place.server,
    host: place.target.host,
    port: place.target.port,
    database: place.target.database,
    searchPath: place.searchPath,
    sql,
  };
  if (args.verbose || args.dry) printMeta(io, shown, options.mode);
  if (args.dry) return { ...shown, dry: true, outcome: null };
  return {
    ...shown,
    dry: false,
    outcome: await execute(
      options.openSession ?? denoSession(options.mode),
      place,
      sql,
      options.mode,
    ),
  };
}

/** Куда идёт вызов: адрес, имя сервера для мета-блока и search_path. */
interface Place {
  readonly server: string;
  readonly target: PgTarget;
  readonly searchPath: string | null;
}

/** Резолв селектора и адрес; кэш-БД открывается только если нужна. */
function placeOf(route: SelectorRoute, args: SqlArgs, io: SqlIo): Place {
  if (route.kind === "dev") {
    return {
      server: "dev",
      target: devTarget(io.envFile),
      searchPath: schemaOf(route.clientId),
    };
  }
  let db: CacheDb | undefined;
  // Кэш открывается первым же запросом резолва, а `sl-N` и `--server`
  // до него не доходят (`platform/selector.md`): неинициализированная
  // БД не должна мешать путям, которым она не нужна.
  const cache: CacheReader = {
    query: (sql, ...params) => (db ??= io.openCacheDb()).query(sql, ...params),
  };
  try {
    const resolved = resolveSelector(
      { cache, env: io.envFile },
      args.selector,
      { server: args.server },
    );
    return {
      server: `sl-${resolved.serverNumber}`,
      target: serverTarget(io.envFile, resolved.serverNumber),
      searchPath: schemaOf(singleClientId(resolved.candidates)),
    };
  } finally {
    db?.[Symbol.dispose]();
  }
}

/** Единственный различный client_id кандидатов; иначе — его нет. */
function singleClientId(
  candidates: readonly { readonly clientId: number | null }[],
): number | null {
  const ids = new Set(
    candidates
      .map((candidate) => candidate.clientId)
      .filter((id): id is number => id !== null),
  );
  const [only] = [...ids];
  return ids.size === 1 ? only : null;
}

function schemaOf(clientId: number | null): string | null {
  return clientId === null ? null : `schema_${clientId}`;
}

/**
 * Текст SQL: аргумент, иначе stdin целиком. Приглашение печатается
 * только на терминале — в пайпе оно было бы мусором в stderr.
 */
async function readSql(args: SqlArgs, io: SqlIo): Promise<string> {
  if (args.sql !== undefined && args.sql.trim() !== "") return args.sql;
  if (io.stdinIsTerminal()) io.progress(PROMPT);
  return await readTextStdin(io);
}

/**
 * Мета-блок в stderr. Команда не печатает сама (инвариант 1 контракта):
 * строки уходят портом хода исполнения, печатает их точка входа.
 */
function printMeta(io: SqlIo, meta: MetaBlock, mode: SqlMode): void {
  // Порт добавляет перевод строки к каждой строке — блок разбирается
  // обратно на строки, чтобы не удвоить последний.
  for (const line of metaText(meta, mode).slice(0, -1).split("\n")) {
    io.progress(line);
  }
}

/**
 * Единственное подключение вызова: открыть, на read-only убедиться в
 * запрете записи, поставить search_path, исполнить пользовательский
 * текст. Соединение
 * закрывается при любом исходе, отказы БД переводятся в классы команды —
 * включая отказ самого подключения (недоступный хост — тоже ошибка БД,
 * а не «unexpected»).
 */
async function execute(
  open: OpenSession,
  place: Place,
  sql: string,
  mode: SqlMode,
): Promise<SqlOutcome> {
  let session: SqlSession | undefined;
  try {
    session = await open(place.target);
    if (mode === "read-only") await assertReadOnly(session);
    if (place.searchPath !== null) {
      await session.query(`SET search_path TO "${place.searchPath}", public`);
    }
    return await session.run(sql);
  } catch (err) {
    throw translate(err);
  } finally {
    // Закрытие не должно подменять исход вызова: результат уже получен
    // либо ошибка уже брошена, а фиксация подтверждена сервером до
    // закрытия — сбой закрытия ничего не теряет.
    await session?.close().catch(() => {});
  }
}

/** Запрет записи проверяется на самом соединении, а не предполагается. */
async function assertReadOnly(session: SqlSession): Promise<void> {
  const outcome = await session.query(READ_ONLY_CHECK);
  const value = outcome.kind === "rows" ? outcome.rows[0]?.[0] : undefined;
  if (value === "on") return;
  throw new DomainError(
    "read-only сессия не действует на этом соединении — запрос не выполнен",
  );
}

/** Отказы БД в классы ошибок команды; прочее уходит наверх как есть. */
function translate(err: unknown): unknown {
  if (err instanceof WriteRefusedError) {
    return new DomainError(WRITE_REFUSED, { cause: err });
  }
  if (err instanceof TransactionEndedError) {
    return new DomainError(TRANSACTION_ENDED, { cause: err });
  }
  if (err instanceof DbError) {
    // Текст сервера печатается без префикса команды (спека, эталон
    // `db-error-stderr.txt`): у него своя форма, включая многострочную.
    return new VerbatimError(`db error: ${err.message}`, { cause: err });
  }
  return err;
}

/** Форма вывода результата по флагам вызова. */
export function formatOf(args: SqlArgs): OutputFormat {
  if (args.json) return "json";
  return args.md ? "md" : "table";
}

/**
 * Селектор в сыром argv: первый позиционный аргумент. Знание о формах
 * записи здесь своё и намеренно грубое — оно нужно раньше разбора
 * схемой, а значение принимает единственный флаг команды.
 */
export function selectorOf(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") return args[index + 1];
    if (arg === "--server") {
      index++;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") continue;
    return arg;
  }
  return undefined;
}

/**
 * Открыватель сессии поверх драйвера. Драйвер грузится динамически:
 * npm-пакет тяжёл, а нужен он одной команде — статический импорт
 * поднимал бы его на каждом запуске бинаря.
 */
export function denoSession(mode: SqlMode): OpenSession {
  return async (target) => {
    const { openPgSession } = await import("./pg.ts");
    return await openPgSession(target, mode);
  };
}
