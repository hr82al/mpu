/**
 * Команды `mpu backup-*` (`docs/specs/backup.md`): копия таблицы
 * клиента в схему `backups`.
 *
 * Ход — прямым соединением с PostgreSQL, а не через контейнер: это не
 * обёртка над sl-back CLI, и в семейство `platform/portainer.md` она не
 * входит. Адрес сервера и креды берутся тем же слоем, что у `mpu sql`
 * (`src/sql/mod.ts`), — второй копии правил подключения не заводится.
 */

import { z } from "@zod/zod";
import {
  type CacheDb,
  type Command,
  type CommandIo,
  defineCommand,
  VerbatimError,
} from "../command/mod.ts";
import { type CacheReader, resolveSelector } from "../selector/mod.ts";
import {
  DbError,
  denoSession,
  type OpenSession,
  type PgTarget,
  serverTarget,
} from "../sql/mod.ts";
import {
  type BackupPlan,
  backupPlan,
  type BackupTable,
  dateSuffix,
  schemaIdOf,
} from "./plan.ts";

const argsSchema = z.object({
  selector: z.string({
    error: "нужен SELECTOR: client_id, spreadsheet_id, заголовок или sl-N",
  }).describe("клиент: client_id, spreadsheet_id, заголовок; либо sl-N"),
  date: z.string().optional().describe(
    "суффикс копии, YYYYMMDD; по умолчанию сегодняшняя дата по Москве",
  ),
  "schema-id": z.number().int().positive().optional().describe(
    "номер схемы клиента; без него выводится из селектора",
  ),
  server: z.string().optional().describe("override сервера: sl-N"),
  dry: z.boolean().default(false).describe(
    "только показать мета-блок и запрос, не подключаясь",
  ),
});

const resultSchema = z.object({
  marketplace: z.string().describe("площадка таблицы-источника"),
  source_table: z.string().describe(
    "таблица-источник со схемой: `schema_<id>.<таблица>`",
  ),
  date_suffix: z.string().describe("суффикс даты в имени копии"),
  server: z.string().describe("`sl-<N>`, где выполняется запрос"),
  pg_host: z.string().describe("адрес PostgreSQL"),
  pg_port: z.number().describe("порт PostgreSQL"),
  database: z.string().describe("база данных"),
  sql: z.string().describe("запрос, который ушёл (или ушёл бы) серверу"),
  dry: z.boolean().describe("режим показа: соединения не было"),
});

type BackupArgs = z.infer<typeof argsSchema>;
type BackupResult = z.infer<typeof resultSchema>;

/** Срез порта: env-файл с адресами, кэш селектора, ход исполнения. */
export type BackupIo = Pick<
  CommandIo,
  "envFile" | "openCacheDb" | "progress"
>;

/** Подстановки для тестов: живого PostgreSQL у них нет. */
export interface BackupOptions {
  readonly openSession?: OpenSession;
  /** Текущее время в миллисекундах; дефолт даты берётся из него. */
  readonly nowMs?: number;
}

/**
 * Один вызов: резолв селектора, план, затем либо показ, либо запрос.
 *
 * Порядок фиксирован: всё, что решается без сети, решается до неё —
 * неверная дата и неоднозначный клиент отбиваются раньше соединения.
 */
export async function runBackup(
  table: BackupTable,
  args: BackupArgs,
  io: BackupIo,
  options: BackupOptions = {},
): Promise<BackupResult> {
  let db: CacheDb | undefined;
  // Кэш открывается первым же запросом резолва, а `sl-N` и `--server`
  // до него не доходят (`platform/selector.md`): неинициализированная
  // БД не должна мешать путям, которым она не нужна, — тем более что
  // бэкап снимают и на сервере, которого в кэше нет.
  const cache: CacheReader = {
    query: (sql, ...params) => (db ??= io.openCacheDb()).query(sql, ...params),
  };
  let resolved;
  try {
    resolved = resolveSelector({ cache, env: io.envFile }, args.selector, {
      server: args.server,
    });
  } finally {
    db?.[Symbol.dispose]();
  }
  const date = dateSuffix(args.date, options.nowMs ?? Date.now());
  const schemaId = schemaIdOf(
    args["schema-id"],
    args.selector,
    resolved.candidates,
  );
  const plan = backupPlan(table, schemaId, date);
  const target = serverTarget(io.envFile, resolved.serverNumber);
  const result = shown(plan, `sl-${resolved.serverNumber}`, target, args.dry);
  if (args.dry) {
    printMeta(io, result);
    return result;
  }
  const session = await (options.openSession ?? denoSession("write"))(target);
  try {
    await session.run(plan.sql);
  } catch (err) {
    // Отказ сервера печатается его же текстом: имя таблицы, схема и
    // права — то, что человек и пойдёт чинить. Префикс команды к нему
    // не добавляется: форма у отказа своя, в том числе многострочная.
    if (err instanceof DbError) {
      throw new VerbatimError(err.message, { cause: err });
    }
    throw err;
  } finally {
    // Закрытие не подменяет исход вызова: результат уже получен либо
    // ошибка уже брошена, а фиксация подтверждена сервером до
    // закрытия — сбой закрытия ничего не теряет.
    await session.close().catch(() => {});
  }
  printMeta(io, result);
  return result;
}

/** Результат вызова: тот же набор полей у показа и у выполнения. */
function shown(
  plan: BackupPlan,
  server: string,
  target: PgTarget,
  dry: boolean,
): BackupResult {
  return {
    marketplace: plan.marketplace,
    source_table: plan.sourceTable,
    date_suffix: plan.dateSuffix,
    server,
    pg_host: target.host,
    pg_port: target.port,
    database: target.database,
    sql: plan.sql,
    dry,
  };
}

/**
 * Мета-блок в stderr: у команды нет данных результата, а служебному
 * тексту место в stdout не полагается (`sql-ro.md`, `d2-miro.md`, та
 * же конвенция). Команда печатает не сама — строки уходят портом хода
 * исполнения, печатает их точка входа (инвариант 1 контракта).
 *
 * Порт добавляет перевод строки к каждой строке, поэтому блок
 * разбирается обратно на строки: иначе последний удвоился бы.
 */
function printMeta(io: BackupIo, result: BackupResult): void {
  for (const line of metaText(result).slice(0, -1).split("\n")) {
    io.progress(line);
  }
}

/**
 * Мета-блок: порядок и имена полей сохранены от рабочей версии
 * (`docs/specs/backup.md`, отклонение `preserve`). Печатается и в
 * показе, и после выполнения — записью о том, что ушло серверу.
 */
function metaText(result: BackupResult): string {
  return [
    `marketplace: ${result.marketplace}`,
    `source_table: ${result.source_table}`,
    `date_suffix: ${result.date_suffix}`,
    `server: ${result.server}`,
    `pg_host: ${result.pg_host}`,
    `pg_port: ${result.pg_port}`,
    `database: ${result.database}`,
    "sql:",
    `${result.sql}\n`,
  ].join("\n");
}

/** Таблицы, с которых снимаются копии; порядок — порядок спеки. */
const TABLES: readonly (readonly [string, BackupTable])[] = [
  ["backup-wb-unit-proto", { marketplace: "wb", table: "wb_unit_proto" }],
  [
    "backup-ozon-unit-proto",
    { marketplace: "ozon", table: "ozon_unit_proto" },
  ],
  [
    "backup-wb-unit-manual-data",
    { marketplace: "wb", table: "wb_unit_manual_data" },
  ],
];

/** Все три команды в порядке объявления. */
export const backupCommands: readonly Command[] = TABLES.map(
  ([name, table]) => backup(name, table),
);

function backup(name: string, table: BackupTable): Command {
  return defineCommand({
    path: [name],
    summary: `Снять копию ${table.table} клиента в схему backups.`,
    usage: `mpu ${name} SELECTOR [--date YYYYMMDD] [--schema-id N] ` +
      "[--server sl-N] [--dry]",
    help: `По умолчанию команда ВЫПОЛНЯЕТСЯ: создаёт в схеме backups
копию таблицы ${table.table} клиента запросом

  CREATE TABLE backups.${table.table}_<schema_id>_<YYYYMMDD> AS
  SELECT * FROM schema_<schema_id>.${table.table};

Соединение прямое, с PostgreSQL сервера клиента: ни docker exec, ни
Portainer здесь нет — это не обёртка над sl-back CLI.

--dry ничего не выполняет и никуда не подключается: печатает мета-блок
и запрос, который ушёл бы серверу. Тот же блок печатается и после
выполнения — записью о том, что было сделано.

SELECTOR — client_id, spreadsheet_id, заголовок таблицы либо сам сервер
(sl-N); --server sl-N задаёт сервер напрямую. --schema-id по умолчанию
равен client_id: он берётся из кандидатов селектора, если у всех
кандидатов он один, а при пустых кандидатах — из самого селектора,
если тот число. Неоднозначность — ошибка ввода со списком кандидатов.

--date — ровно восемь цифр (YYYYMMDD); по умолчанию сегодняшняя дата по
Москве. Неверная дата отбивается до соединения.

Exit: 0 — копия создана либо показана; 1 — отказ PostgreSQL; 2 — ошибки
ввода, резолва и конфигурации.

Примеры: mpu ${name} 777 --dry; mpu ${name} 777 --date 20260827`,
    // Мутирующая: CREATE TABLE в базе клиента. `--dry` — режим флага, а
    // не отдельная читающая команда: класс объявляется командой и от
    // аргументов не зависит (`platform/command-contract.md`).
    policy: "rw",
    helpWhenBare: true,
    argsSchema,
    forms: { selector: { positional: "one" } },
    resultSchema,
    run: (args, io: BackupIo) => runBackup(table, args, io),
    // stdout не используется вовсе (`backup.md`, отклонение `fix`):
    // данных результата у команды нет, а мета-блок ушёл в stderr.
    render: () => "",
  });
}
