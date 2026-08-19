/**
 * Команда `mpu search` (`docs/specs/search.md`): поиск клиента или
 * таблицы по селектору в локальном кэше и доступ к web-клиенту 10X.
 *
 * Ветку выбирают флаги и форма селектора (`./mode.ts`). В этой порции
 * реализован локальный режим; обе 10X-ветки объявлены и отказывают
 * внятно — команда пока не зарегистрирована в реестре, полукоманды
 * пользователь не видит.
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand, UsageError } from "../command/mod.ts";
import { runUpdate } from "../update/mod.ts";
import { modeOf, type Scope } from "./mode.ts";
import { type LocalIo, searchLocal, type SyncCache } from "./local.ts";
import {
  type Projection,
  projectionOf,
  PROJECTIONS,
  type SearchRow,
} from "./row.ts";

/** Порт исполнения команды. */
export type SearchIo = LocalIo & Pick<CommandIo, "env">;

const rowSchema = z.object({
  client_id: z.number().int().nullable(),
  spreadsheet_id: z.string().nullable(),
  title: z.string().nullable(),
  server: z.string().nullable(),
  server_number: z.number().int().nullable(),
  sl_ip: z.string().nullable(),
  pg_ip: z.string().nullable(),
  sids: z.array(z.string()),
});

const argsSchema = z.object({
  value: z.string().describe(
    "селектор: client_id, таблица, заголовок, sid, IP, email",
  ),
  "client-id": z.boolean().default(false).describe("печатать только client_id"),
  "spreadsheet-id": z.boolean().default(false).describe(
    "печатать только spreadsheet_id",
  ),
  title: z.boolean().default(false).describe("печатать только заголовок"),
  server: z.boolean().default(false).describe("печатать только сервер"),
  "server-number": z.boolean().default(false).describe(
    "печатать только номер сервера",
  ),
  "sl-ip": z.boolean().default(false).describe("печатать только адрес sl"),
  "pg-ip": z.boolean().default(false).describe("печатать только адрес pg"),
  sids: z.boolean().default(false).describe(
    "печатать только WB-кабинеты через запятую",
  ),
  update: z.boolean().default(true).describe(
    "на пустом результате обновить кэш и повторить поиск",
  ),
  reason: z.string().optional().describe(
    "причина impersonation для аудита 10X; дефолт «ТП <дата>»",
  ),
  "refresh-cache": z.boolean().default(false).describe(
    "не верить кэшу 10X: перерезолвить через API",
  ),
  scope: z.enum(["auto", "user", "access"]).default("auto").describe(
    "область staff-поиска 10X",
  ),
});

const resultSchema = z.object({
  rows: z.array(rowSchema).describe("строки результата в порядке спеки"),
  /** Имя проекции без `--`; без флага — null, и печатается JSON. */
  projection: z.string().nullable(),
  /** Был ли догоняющий синк кэша (`--update` на пустом результате). */
  synced: z.boolean(),
});

/** Разобранные аргументы команды. */
export type SearchArgs = z.infer<typeof argsSchema>;
export type SearchResult = z.infer<typeof resultSchema>;

/** Подмены для тестов: живого PG у догоняющего синка нет. */
export interface SearchOptions {
  readonly sync?: SyncCache;
}

export const searchCommand = defineCommand({
  path: ["search"],
  summary: "Найти клиента или таблицу по селектору; вход в 10X по email.",
  usage:
    "mpu search VALUE [проекция] [--no-update] [--reason TEXT] [--refresh-cache] [--scope auto|user|access]",
  help: `Ищет по локальному кэшу (\`mpu init\`/\`mpu update\`) и печатает
JSON-массив строк с восемью полями: client_id, spreadsheet_id, title,
server, server_number, sl_ip, pg_ip, sids. Ничего не нашлось — [] и
exit 0.

VALUE — client_id, spreadsheet_id, кусок заголовка, WB-кабинет, адрес
сервера или email. Порядок предикатов общий для всех команд: client_id,
адрес, кабинет, spreadsheet_id, заголовок.

Проекция печатает голое значение одного поля по строке результата:
--client-id, --spreadsheet-id, --title, --server, --server-number,
--sl-ip, --pg-ip, --sids (кабинеты через запятую). Больше одной
проекции — ошибка ввода до всякого чтения БД.

Пустой результат сам обновляет кэш (полный синк, тихо) и повторяет поиск
ровно один раз; --no-update это снимает. Для селектора-адреса синк не
запускается: адреса живут в env-файле, а не в кэше.

Exit: 0 — успех, включая пустой результат; 1 — сбой обновления кэша;
2 — ошибки ввода.

Примеры: mpu search 777; mpu search 'Отчёт' --client-id;
mpu search 10.9.9.9 --no-update`,
  // Локальный режим только читает, но дефолтный `--update` пишет кэш, а
  // 10X-ветка создаёт audit-запись impersonation на проде.
  policy: "rw",
  // Голый вызов печатает справку: у поиска нет осмысленного вызова без
  // селектора (спека, «CLI-контракт»).
  helpWhenBare: true,
  // В журнале вызовов секций вывода у поиска нет: stdout 10X-ветки несёт
  // живые токены (`platform/invoke-log.md`).
  logsOutput: false,
  argsSchema,
  forms: { value: { positional: "one" } },
  resultSchema,
  run: (args, io: SearchIo) => runSearch(args, io),
  render: renderSearch,
});

/**
 * Прогон команды. Вынесено из объявления ради одной подмены —
 * догоняющего синка: живого PostgreSQL в тестах нет, а поиск обязан
 * проверяться вместе с правилом «синк ровно один раз».
 */
export async function runSearch(
  args: SearchArgs,
  io: SearchIo,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const projection = projectionFlag(args);
  const mode = modeOf({
    value: args.value,
    scope: args.scope as Scope,
    reasonGiven: args.reason !== undefined,
    refreshCache: args["refresh-cache"],
  });
  if (mode !== "local") {
    // Ветки 10X приезжают следующим шагом порции; команда до тех пор не
    // зарегистрирована, и этот отказ виден только тестам.
    throw new UsageError("ветка 10X ещё не перенесена");
  }
  const outcome = await searchLocal(
    { value: args.value, update: args.update },
    io,
    options.sync ?? quietSync,
  );
  // Результат — данные схемы, а не внутренние структуры: списки
  // копируются, чтобы форма была ровно та, что объявлена (и переживала
  // JSON без сюрпризов).
  return {
    rows: outcome.rows.map((row) => ({ ...row, sids: [...row.sids] })),
    projection,
    synced: outcome.synced,
  };
}

/** Вывод: JSON-массив строк либо голые значения проекции по строке. */
export function renderSearch(result: SearchResult): string {
  if (result.projection === null) {
    // Отступ 2 и unicode как есть: русские заголовки идут буквами, а не
    // escape-последовательностями (спека, «Ввод/вывод»).
    return `${JSON.stringify(result.rows, null, 2)}\n`;
  }
  const projection = result.projection as Projection;
  return result.rows
    .map((row) => `${projectionOf(row as SearchRow, projection)}\n`)
    .join("");
}

/**
 * Единственная проекция или отказ. Проверяется до всякого чтения БД и
 * сети: голден канала требует пустого stdout у этого отказа.
 */
function projectionFlag(args: SearchArgs): string | null {
  const given = PROJECTIONS.filter((name) => args[name] === true);
  if (given.length > 1) {
    throw new UsageError("only one projection flag allowed");
  }
  return given[0] ?? null;
}

/** Догоняющий синк: полный тихий прогон `mpu update`. */
async function quietSync(io: LocalIo): Promise<void> {
  await runUpdate({ quiet: true }, io);
}
