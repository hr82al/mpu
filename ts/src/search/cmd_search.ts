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
import {
  ClientNotFoundError,
  runClientSync,
  runUpdate,
} from "../update/mod.ts";
import { searchCandidates } from "../selector/mod.ts";
import { effectiveScope, modeOf, type Scope } from "./mode.ts";
import { localDate } from "../dates/mod.ts";
import { type LocalIo, searchLocal, type SyncCache } from "./local.ts";
import {
  type Projection,
  projectionOf,
  PROJECTIONS,
  rowsOf,
  type SearchRow,
} from "./row.ts";
import { bareRow, resolveX10, targetSessions } from "./x10_branch.ts";
import { x10BaseUrl, type X10Send } from "./x10_http.ts";

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

const sessionSchema = z.object({
  kind: z.string(),
  subject: z.string(),
  reason: z.string().nullable(),
  created_at: z.number().int(),
  expires_at: z.number().int(),
  valid: z.boolean(),
  token: z.string(),
});

const targetSchema = z.object({
  email: z.string(),
  target_user_id: z.string(),
  target_name: z.string().nullable(),
  is_email_verified: z.boolean(),
  reason: z.string(),
  fetched_at: z.number().int(),
  owned: z.array(rowSchema),
  member_only: z.array(z.object({
    workspace_id: z.number().int().nullable(),
    name: z.string().nullable(),
    marketplace: z.string().nullable(),
  })),
  sessions: z.array(sessionSchema),
  workspaces: z.array(z.record(z.string(), z.unknown())),
});

const candidateSchema = z.object({
  user_id: z.number().int(),
  email: z.string(),
  name: z.string().nullable(),
  match: z.record(z.string(), z.unknown()).nullable(),
});

const resultSchema = z.object({
  rows: z.array(rowSchema).describe("строки результата в порядке спеки"),
  /** Имя проекции без `--`; без флага — null, и печатается JSON. */
  projection: z.string().nullable(),
  /** Был ли догоняющий синк кэша (`--update` на пустом результате). */
  synced: z.boolean(),
  /** Цель 10X; в локальном режиме — null. */
  target: targetSchema.nullable(),
  /**
   * Кандидаты неоднозначного staff-поиска. Они не ошибка разбора: список
   * печатается в stdout, а команда отвечает кодом 2 — impersonation при
   * этом не создаётся (спека, «10X-резолв не-email селектора»).
   */
  ambiguous: z.array(candidateSchema).nullable(),
});

/** Разобранные аргументы команды. */
export type SearchArgs = z.infer<typeof argsSchema>;
export type SearchResult = z.infer<typeof resultSchema>;

/** Подмены для тестов: живого PG и живого 10X у них нет. */
export interface SearchOptions {
  readonly sync?: SyncCache;
  /** Точечный синк одного клиента (дотягивание owned вне снапшота). */
  readonly syncClient?: (io: LocalIo, clientId: number) => Promise<void>;
  /** Отправитель запросов 10X. */
  readonly send?: X10Send;
  /** Текущий момент в unix-секундах; по умолчанию — часы машины. */
  readonly nowSeconds?: () => number;
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
  // Неоднозначный staff-поиск — не ошибка разбора: список кандидатов
  // печатается в stdout, а код возврата всё равно 2 (спека).
  textExitCode: (result) => result.ambiguous === null ? 0 : 2,
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
  if (mode === "local") {
    const outcome = await searchLocal(
      { value: args.value, update: args.update },
      io,
      options.sync ?? quietSync,
    );
    return {
      // Результат — данные схемы, а не внутренние структуры: списки
      // копируются, чтобы форма была ровно та, что объявлена (и
      // переживала JSON без сюрпризов).
      rows: outcome.rows.map(plainRow),
      projection,
      synced: outcome.synced,
      target: null,
      ambiguous: null,
    };
  }
  return await runX10(args, io, options, projection);
}

/**
 * Ветка 10X: резолв цели, строки её владений и сессии. Живого 10X в
 * тестах нет — отправитель запросов подменяется, как и оба синка.
 */
async function runX10(
  args: SearchArgs,
  io: SearchIo,
  options: SearchOptions,
  projection: string | null,
): Promise<SearchResult> {
  const nowSeconds = (options.nowSeconds ?? defaultNow)();
  using db = io.openCacheDb();
  const deps = {
    db,
    env: io.envFile,
    baseUrl: x10BaseUrl(io.envFile),
    send: options.send,
    nowSeconds,
    envFilePath: envFilePathOf(io),
  };
  const outcome = await resolveX10(deps, {
    value: args.value,
    scope: args.scope as Scope,
    reason: args.reason ?? defaultReason(nowSeconds),
    refreshCache: args["refresh-cache"],
  });
  if (outcome.kind === "ambiguous") {
    // Текст отказа идёт служебным каналом (stderr), а список кандидатов —
    // в stdout: команда обязана отдать оба, а результат у неё один
    // (спека, «10X-резолв не-email селектора»).
    io.progress(
      `mpu search: 10X staff search (scope=${
        effective(args)
      }): по '${args.value}' найдено кандидатов: ${outcome.candidates.length};` +
        " повтори с точным email или с user.id (--scope user)",
    );
    return {
      rows: [],
      projection,
      synced: false,
      target: null,
      ambiguous: outcome.candidates.map((user) => ({
        user_id: user.id,
        email: user.email,
        name: user.name,
        match: user.match === null ? null : { ...user.match },
      })),
    };
  }
  const target = outcome.target;
  const owned = await ownedRows(target.owned_client_ids, io, options);
  return {
    rows: owned.map(plainRow),
    projection,
    synced: false,
    target: {
      email: target.email,
      target_user_id: target.target_user_id,
      target_name: target.target_name,
      is_email_verified: target.is_email_verified,
      reason: target.reason,
      fetched_at: target.fetched_at,
      owned: owned.map(plainRow),
      member_only: target.member_only.map((workspace) => ({ ...workspace })),
      sessions: targetSessions(
        db,
        io.envFile.get("X10_LOGIN") ?? null,
        Number(target.target_user_id),
        nowSeconds,
      ).map((session) => ({
        kind: session.kind,
        subject: session.subject,
        reason: session.reason,
        created_at: session.createdAt,
        expires_at: session.expiresAt,
        valid: session.valid,
        token: session.token,
      })),
      workspaces: target.workspaces.map((workspace) => ({ ...workspace })),
    },
    ambiguous: null,
  };
}

/**
 * Строки владений цели. Клиента нет в снапшоте — он дотягивается
 * точечным синком; не нашёлся и там — предупреждение и «голая» строка,
 * а не отказ: владение реально, просто реестр о нём не знает (спека).
 */
async function ownedRows(
  clientIds: readonly number[],
  io: SearchIo,
  options: SearchOptions,
): Promise<readonly SearchRow[]> {
  const rows: SearchRow[] = [];
  for (const clientId of clientIds) {
    const found = localRows(io, clientId);
    if (found.length > 0) {
      rows.push(...found);
      continue;
    }
    await (options.syncClient ?? pointSync)(io, clientId).catch((err) => {
      // Клиента нет и в main — это не сбой команды: ниже он покажется
      // голой строкой с предупреждением.
      if (!(err instanceof ClientNotFoundError)) throw err;
    });
    const afterSync = localRows(io, clientId);
    if (afterSync.length > 0) {
      rows.push(...afterSync);
      continue;
    }
    io.progress(
      `warning: client ${clientId} не найден в реестре (показан без таблицы)`,
    );
    rows.push(bareRow(clientId));
  }
  return rows;
}

/** Строки клиента из локального кэша; своё соединение на проход. */
function localRows(io: SearchIo, clientId: number): readonly SearchRow[] {
  using db = io.openCacheDb();
  return rowsOf(
    searchCandidates({ cache: db, env: io.envFile }, String(clientId)),
    io.envFile,
  );
}

/**
 * Вывод: JSON локального результата, JSON-объект цели 10X либо список
 * кандидатов неоднозначного поиска. С проекцией печатаются только строки
 * (у цели — её владения), по голому значению на строку.
 */
export function renderSearch(result: SearchResult): string {
  if (result.ambiguous !== null) {
    return `${JSON.stringify(result.ambiguous, null, 2)}\n`;
  }
  if (result.projection !== null) {
    const projection = result.projection as Projection;
    return result.rows
      .map((row) => `${projectionOf(row as SearchRow, projection)}\n`)
      .join("");
  }
  // Отступ 2 и unicode как есть: русские заголовки идут буквами, а не
  // escape-последовательностями (спека, «Ввод/вывод»).
  const shown = result.target ?? result.rows;
  return `${JSON.stringify(shown, null, 2)}\n`;
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

/** Строка результата как данные схемы: список копируется. */
function plainRow(row: SearchRow) {
  return { ...row, sids: [...row.sids] };
}

/** Эффективный scope для текста отказа о неоднозначности. */
function effective(args: SearchArgs): string {
  return effectiveScope(args.value, args.scope as Scope);
}

/** Причина impersonation по умолчанию: `ТП <YYYY-MM-DD>` (спека). */
function defaultReason(nowSeconds: number): string {
  return `ТП ${localDate(nowSeconds * 1000, new Date().getTimezoneOffset())}`;
}

function defaultNow(): number {
  return Math.floor(Date.now() / 1000);
}

/** Путь env-файла для текста отказа о недостающих кредах. */
function envFilePathOf(io: SearchIo): string {
  const home = io.env("HOME") ?? "~";
  return `${home}/.config/mpu/.env`;
}

/** Точечный синк по умолчанию — продуктовый прогон `mpu update`. */
async function pointSync(io: LocalIo, clientId: number): Promise<void> {
  await runClientSync(io, clientId);
}
