/**
 * Команда `mpu sql-ro` (`docs/specs/sql-ro.md`): ad-hoc SQL по селектору
 * в enforced read-only сессии PostgreSQL. Запрет записи держит сервер, а
 * не разбор текста запроса (`platform/readonly-default.md`).
 *
 * Здесь порядок шагов вызова и его аргументы; формы вывода — `render.ts`,
 * адрес и маршрут — `target.ts`, сама сессия — порт `session.ts`.
 */

import { z } from "@zod/zod";
import {
  type CacheDb,
  type CommandIo,
  defineCommand,
  DomainError,
  UsageError,
  VerbatimError,
} from "../command/mod.ts";
import { type CacheReader, resolveSelector } from "../selector/mod.ts";
import { type MetaBlock, metaText } from "./meta.ts";
import { type OutputFormat, renderOutcome, type SqlOutcome } from "./render.ts";
import {
  DbError,
  type OpenReadOnlySession,
  type ReadOnlySession,
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

/** Текст сам завершил транзакцию вызова — текст спеки дословно. */
const TRANSACTION_ENDED = "текст завершил транзакцию вызова — гарантия " +
  "только-чтения снята, результат не печатается";

const argsSchema = z.object({
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

const resultSchema = z.object({
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

/** Разобранные аргументы `mpu sql-ro`. */
export type SqlRoArgs = z.infer<typeof argsSchema>;

/** Результат вызова: из него рендерится stdout. */
export type SqlRoResult = z.infer<typeof resultSchema>;

export const sqlRoCommand = defineCommand({
  path: ["sql-ro"],
  // Однострока — из слепка дерева: имя и описание переехавшей команды
  // видит режим дополнения, и расходиться с эталоном им незачем.
  summary:
    "Выполнить SQL в enforced read-only сессии (безопасный дефолт для чтения).",
  usage: "mpu sql-ro SELECTOR [SQL] [--server sl-N] [--dry] [--json|--md] [-v]",
  help: `Запись отклоняет сам сервер (SQLSTATE 25006), а не разбор
текста запроса; для записи — \`mpu sql\`.

SELECTOR: sl-N (сервер целиком, main — sl-0), dev:<client_id>
(dev-стенд, схема schema_<client_id>), sw-алиас (БД воркспейсов) либо
поиск по кэшу. Ровно один client_id среди кандидатов — search_path на
его схему, иначе search_path сервера. --server sl-N резолв отменяет.

SQL — второй аргумент, иначе stdin целиком (с терминала — до Ctrl+D);
пустой — ошибка ввода без подключения. Уходит серверу как есть, одним
вызовом: печатается результат ПЕРВОГО оператора, ошибка любого — отказ
всего вызова.

Вывод: таблица, --json (массив объектов), --md; вместе --json и --md —
ошибка ввода. --dry: мета-блок и SQL без подключения; -v — тот же блок
при обычном прогоне.

Ключи env-файла (окружение процесса не читается): pg_<N>, PG_PORT
(5432), PG_DB_NAME (wb), PG_MY_USER_NAME/PG_MAIN_USER_NAME и пароли
PG_MY_USER_PASSWORD/PG_MAIN_USER_PASSWORD; для dev — DEV_PG_HOST,
DEV_PG_PORT (5434), DEV_PG_DB (mp_sl_1_dev), DEV_PG_USER,
DEV_PG_PASSWORD.

Exit: 0 — успех, включая --dry и запрос без набора строк; 1 — отказ
записи и ошибка БД; 2 — ошибка ввода, резолва и конфигурации.

Пример: mpu sql-ro 42 'SELECT count(*) FROM orders' --json`,
  policy: "ro",
  argsSchema,
  forms: {
    selector: { positional: "one" },
    sql: { positional: "one" },
    verbose: { short: "v" },
  },
  resultSchema,
  // Вызов с sw-селектором целиком исполняет прежняя реализация
  // (`specs/sql-ro.md`, маршрут 2): argv разбирается ею же, поэтому
  // селектор ищется в сыром argv, до схемы.
  bridge: (args) => routeOf(selectorOf(args) ?? "").kind === "sw",
  run: (args, io) => runSqlRo(args, io),
  render: (result, args) =>
    result.outcome === null
      ? ""
      : renderOutcome(result.outcome, formatOf(args)),
});

/** Подмена для тестов: живого PostgreSQL у них нет. */
export interface SqlRoOptions {
  readonly openSession?: OpenReadOnlySession;
}

/**
 * Прогон команды. Вынесено из объявления ради подмены открывателя
 * сессии; команда зовёт эту функцию без подмен.
 */
export async function runSqlRo(
  args: SqlRoArgs,
  io: CommandIo,
  options: SqlRoOptions = {},
): Promise<SqlRoResult> {
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
  if (args.verbose || args.dry) printMeta(io, shown);
  if (args.dry) return { ...shown, dry: true, outcome: null };
  return {
    ...shown,
    dry: false,
    outcome: await execute(
      options.openSession ?? denoSession(),
      place,
      sql,
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
function placeOf(route: SelectorRoute, args: SqlRoArgs, io: CommandIo): Place {
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
async function readSql(args: SqlRoArgs, io: CommandIo): Promise<string> {
  if (args.sql !== undefined && args.sql.trim() !== "") return args.sql;
  if (io.stdinIsTerminal()) io.progress(PROMPT);
  return await io.readTextStdin();
}

/**
 * Мета-блок в stderr. Команда не печатает сама (инвариант 1 контракта):
 * строки уходят портом хода исполнения, печатает их точка входа.
 */
function printMeta(io: CommandIo, meta: MetaBlock): void {
  // Порт добавляет перевод строки к каждой строке — блок разбирается
  // обратно на строки, чтобы не удвоить последний.
  for (const line of metaText(meta).slice(0, -1).split("\n")) io.progress(line);
}

/**
 * Единственное подключение вызова: открыть, убедиться в запрете записи,
 * поставить search_path, исполнить пользовательский текст. Соединение
 * закрывается при любом исходе, отказы БД переводятся в классы команды —
 * включая отказ самого подключения (недоступный хост — тоже ошибка БД,
 * а не «unexpected»).
 */
async function execute(
  open: OpenReadOnlySession,
  place: Place,
  sql: string,
): Promise<SqlOutcome> {
  let session: ReadOnlySession | undefined;
  try {
    session = await open(place.target);
    await assertReadOnly(session);
    if (place.searchPath !== null) {
      await session.query(`SET search_path TO "${place.searchPath}", public`);
    }
    return await session.run(sql);
  } catch (err) {
    throw translate(err);
  } finally {
    // Закрытие не должно подменять исход вызова: результат уже получен
    // либо ошибка уже брошена, и сбой закрытия читающей сессии ничего
    // не теряет.
    await session?.close().catch(() => {});
  }
}

/** Запрет записи проверяется на самом соединении, а не предполагается. */
async function assertReadOnly(session: ReadOnlySession): Promise<void> {
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

function formatOf(args: SqlRoArgs): OutputFormat {
  if (args.json) return "json";
  return args.md ? "md" : "table";
}

/**
 * Селектор в сыром argv: первый позиционный аргумент. Знание о формах
 * записи здесь своё и намеренно грубое — оно нужно раньше разбора
 * схемой, а значение принимает единственный флаг команды.
 */
function selectorOf(args: readonly string[]): string | undefined {
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
function denoSession(): OpenReadOnlySession {
  return async (target) => {
    const { openPgSession } = await import("./pg.ts");
    return await openPgSession(target);
  };
}
