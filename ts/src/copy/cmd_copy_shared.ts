/**
 * Команда `mpu copy-shared` (`docs/specs/copy-shared.md`): обновить 18
 * общих справочных таблиц схемы `shared` в локальном dev-PG.
 *
 * Своей копии данных у команды нет: перенос делает `pgDataTransfer` в
 * контейнере dt-host, а команда собирает вызов и доносит его код 1:1.
 * Отсюда и форма тестов — проверяется собранная argv, а не SQL.
 *
 * Селектор влияет ровно на одно: адрес source-PG. Целевой адрес
 * фиксирован (`127.0.0.1:5441`) — настраиваемый target провоцировал бы
 * запуск очистки против чужой БД (`copy-shared.md`, отклонение
 * preserve).
 */

import { z } from "@zod/zod";
import {
  type CacheDb,
  type CommandIo,
  defineCommand,
  UsageError,
} from "../command/mod.ts";
import { type CacheReader, resolveSelector } from "../selector/mod.ts";
import { shellCommand } from "../exec/mod.ts";

const argsSchema = z.object({
  selector: z.string({
    error: "нужен SELECTOR: sl-N, client_id или заголовок",
  }).describe("сервер-источник: используется только его номер"),
});

const resultSchema = z.object({
  command: z.string().describe("собранная локальная команда одной строкой"),
  exitCode: z.number().int().describe("код переносящего процесса, 1:1"),
});

type SharedArgs = z.infer<typeof argsSchema>;
type SharedResult = z.infer<typeof resultSchema>;

/** Срез порта: кэш селектора, env-файл, окружение и печать. */
export type SharedIo = Pick<
  CommandIo,
  "env" | "envFile" | "openCacheDb" | "progress" | "stdinIsTerminal"
>;

/** Запуск локального процесса с прокинутым выводом. */
export type RunLocal = (
  argv: readonly string[],
  cwd: string,
) => Promise<number>;

/** Подстановки для тестов: docker у них нет. */
export interface SharedOptions {
  readonly runLocal?: RunLocal;
  readonly exists?: (path: string) => boolean;
}

/**
 * Общие таблицы в порядке спеки. Порядок и состав фиксированы и от
 * селектора не зависят: это справочники, а не данные клиента.
 */
export const SHARED_TABLES: readonly string[] = [
  "currency_rates",
  "mp_stats_wb_conversions",
  "mp_stats_wb_subjects_cards_ratings",
  "mp_stats_wb_subjects_buyouts_percents",
  "mp_manager_wb_adverts_conversions_search",
  "mp_manager_wb_adverts_conversions_auto",
  "mp_manager_wb_conversions",
  "wb_subjects",
  "wb_tariffs_box",
  "wb_tariffs_commissions",
  "wb_warehouses_okrug_names",
  "wb_storages_priority",
  "wb_calendar_promotions",
  "wb_tariffs_pallet",
  "ozon_categories",
  "ozon_localization_coefficients",
  "ozon_actions",
  "ozon_size_attributes_priority",
];

/** Целевой порт локального dev-PG; зашит (отклонение preserve). */
const TARGET_PORT = "5441";

/** Каталог mp-config-local: переменная окружения, иначе путь от HOME. */
export function configDirOf(io: SharedIo): string {
  const override = io.env("MPU_MP_CONFIG_LOCAL");
  if (override !== undefined && override !== "") return override;
  const home = io.env("HOME") ?? "~";
  return `${home}/mr/mp/mp-config-local`;
}

/** Inner-команда переноса: она исполняется внутри контейнера cli. */
export function innerCommand(sourceHost: string): string {
  return [
    "node",
    "src/pgDataTransfer.js",
    "transferTablesViaPsql",
    `--s-host=${sourceHost}`,
    "--s-port=5432",
    "--t-port",
    TARGET_PORT,
    "--schema",
    "shared",
    // Каждая таблица очищается перед наполнением: команда приводит
    // справочники к состоянию источника, а не доливает в них.
    "--clear-tables",
    "--tables",
    ...SHARED_TABLES,
  ].join(" ");
}

/** Argv локального вызова: compose-обёртка вокруг inner-команды. */
export function composeArgs(
  configDir: string,
  sourceHost: string,
  interactive: boolean,
  exists: (path: string) => boolean,
): readonly [string, ...string[]] {
  const argv: string[] = ["docker", "compose"];
  const envFiles: readonly (readonly [string, boolean])[] = [
    [".sl-base.env", false],
    [".env", true],
    [".sl-dt.base.env", false],
    [".sl-dt.env", true],
  ];
  for (const [name, optional] of envFiles) {
    const path = `${configDir}/${name}`;
    // Необязательный файл включается только по факту наличия: его
    // отсутствие штатно, а вот отсутствие базового — отказ compose'а.
    if (optional && !exists(path)) continue;
    argv.push("--env-file", path);
  }
  argv.push("-f", `${configDir}/compose.sl-dt-host.yaml`, "exec");
  // `-it` только при терминале: без него docker откажется выделять tty.
  argv.push(
    interactive ? "-it" : "-i",
    "cli",
    "sh",
    "-c",
    innerCommand(sourceHost),
  );
  return argv as [string, ...string[]];
}

/** Ход вызова: резолв сервера, сборка команды, запуск переноса. */
export async function runCopyShared(
  args: SharedArgs,
  io: SharedIo,
  options: SharedOptions = {},
): Promise<SharedResult> {
  const run = options.runLocal ?? spawnLocal;
  const exists = options.exists ?? existsOnDisk;

  let db: CacheDb | undefined;
  const cache: CacheReader = {
    query: (sql, ...params) => (db ??= io.openCacheDb()).query(sql, ...params),
  };
  let serverNumber: number;
  try {
    serverNumber = resolveSelector({ cache, env: io.envFile }, args.selector)
      .serverNumber;
  } finally {
    db?.[Symbol.dispose]();
  }

  const key = `pg_${serverNumber}`;
  const sourceHost = io.envFile.get(key);
  if (sourceHost === undefined || sourceHost === "") {
    throw new UsageError(`${key} not found in ~/.config/mpu/.env`);
  }
  const configDir = configDirOf(io);
  if (!exists(configDir)) {
    throw new UsageError(
      `mp-config-local dir not found: ${configDir}`,
      { hint: "override via MPU_MP_CONFIG_LOCAL=..." },
    );
  }
  const composeFile = `${configDir}/compose.sl-dt-host.yaml`;
  if (!exists(composeFile)) {
    throw new UsageError(`compose file not found: ${composeFile}`);
  }

  const argv = composeArgs(
    configDir,
    sourceHost,
    io.stdinIsTerminal(),
    exists,
  );
  const command = shellCommand(argv);
  io.progress(`$ ${command}`);
  // Код переносящего процесса становится кодом команды 1:1: свои
  // сообщения поверх чужого отказа только мешали бы читать причину.
  const exitCode = await run(argv, configDir);
  return { command, exitCode };
}

/** Существует ли путь; ошибка доступа равнозначна отсутствию. */
function existsOnDisk(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Настоящий запуск: потоки процесса достаются оператору как есть. */
const spawnLocal: RunLocal = async (argv, cwd) => {
  const [bin, ...rest] = argv;
  const output = await new Deno.Command(bin, {
    args: rest,
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  return output.code;
};

/** stdout пуст: вывод переноса уже ушёл оператору потоками процесса. */
export function renderCopyShared(): string {
  return "";
}

export const copySharedCommand = defineCommand({
  path: ["copy-shared"],
  errorName: "copy-shared",
  summary: "Обновить общие справочные таблицы shared в локальном стенде.",
  usage: "mpu copy-shared SELECTOR",
  help: `Переносит 18 справочных таблиц схемы shared с выбранного
сервера в локальный dev-PG. Каждая таблица очищается и наполняется
заново, структура не меняется: новые колонки приезжают миграциями, а не
этой командой.

SELECTOR влияет ровно на одно — адрес источника: и sl-N, и client_id, и
заголовок таблицы дают один и тот же результат, до клиента селектор не
сужается. Целевой адрес 127.0.0.1:5441 зашит: настраиваемая цель
провоцировала бы очистку чужой БД.

Сам перенос выполняет pgDataTransfer в контейнере dt-host; команда
печатает собранный вызов перед запуском, а его вывод и код возврата
доносит как есть.

Если на таблицу shared ссылается внешний ключ, перенос честно падает —
зависимые данные не удаляются.

Ключи env-файла: pg_<N> — адрес источника. Каталог mp-config-local
берётся из MPU_MP_CONFIG_LOCAL, иначе ~/mr/mp/mp-config-local.

Exit: код переносящего процесса; 2 — резолв селектора, нет pg_<N>, нет
каталога или compose-файла.

Примеры: mpu copy-shared sl-1; mpu copy-shared 5175`,
  policy: "rw",
  argsSchema,
  forms: { selector: { positional: "one" } },
  resultSchema,
  run: (args: SharedArgs, io: SharedIo) => runCopyShared(args, io),
  render: () => renderCopyShared(),
  textExitCode: (result: SharedResult) => result.exitCode,
});
