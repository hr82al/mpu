/**
 * Команда `mpu clean-local-clients`
 * (`docs/specs/clean-local-clients.md`): снести per-client данные
 * локального стенда, кроме keep-листа.
 *
 * Команда деструктивна и потому по умолчанию суха: без `--yes` она
 * только читает список схем и печатает план. Хосты подключений зашиты
 * `127.0.0.1` — прод недостижим никакой комбинацией параметров, и это
 * не настройка, а свойство команды.
 *
 * Удаляется только собственная проводка: вход в sw-front ищется по
 * email-сигнатуре `client_<id>@local.host`. Заведённый вручную под
 * другим адресом не снимается, даже если номер клиента совпал —
 * решение спеки (`preserve`): команда убирает то, что завела сама, а
 * снос чужой учётной записи из-за совпадения номера был бы хуже
 * остатка.
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand, UsageError } from "../command/mod.ts";
import { openPgSession } from "../sql/pg.ts";
import type { SqlOutcome } from "../sql/render.ts";
import type { SqlSession } from "../sql/session.ts";
import type { PgTarget } from "../sql/target.ts";
import {
  clientsOf,
  DRY_RUN_TAIL,
  localEmail,
  NOTHING_TAIL,
  parseKeep,
  planReport,
  sl0Sql,
  sl1Sql,
  targetsOf,
} from "./plan.ts";

const argsSchema = z.object({
  keep: z.string().optional().describe(
    "client_id через запятую, которых оставить; дефолт 54,776",
  ),
  yes: z.boolean().default(false).describe(
    "выполнить удаление; без флага — только печать плана",
  ),
});

const resultSchema = z.object({
  clients: z.array(z.number()).describe("локальные клиенты sl-1"),
  keep: z.array(z.number()).describe("keep-лист вызова"),
  targets: z.array(z.number()).describe("клиенты под удаление"),
  deleted: z.number().describe("сколько клиентов удалено; dry-run — 0"),
  workspaces: z.number().describe("сколько workspace-проводок снято"),
  dryRun: z.boolean(),
});

type CleanArgs = z.infer<typeof argsSchema>;
type CleanResult = z.infer<typeof resultSchema>;

/** Срез порта: подключения берутся из env-файла. */
export type CleanIo = Pick<CommandIo, "envFile">;

/** Открыватель сессии; шов для тестов без живого PostgreSQL. */
export type OpenLocalSession = (target: PgTarget) => Promise<SqlSession>;

/** Подстановки для тестов. */
export interface CleanOptions {
  readonly openSession?: OpenLocalSession;
}

/** Хост локальных подключений зашит: прод недостижим (спека). */
const LOCAL_HOST = "127.0.0.1";

/** Первая колонка первой строки; набора строк нет — `undefined`. */
function firstColumn(outcome: SqlOutcome): string | undefined {
  if (outcome.kind !== "rows") return undefined;
  const first = outcome.rows[0]?.[0];
  return first === undefined || first === null ? undefined : String(first);
}

/** Первая колонка всех строк результата. */
function firstColumnAll(outcome: SqlOutcome): readonly string[] {
  if (outcome.kind !== "rows") return [];
  return outcome.rows
    .map((row) => row[0])
    .filter((value) => value !== null && value !== undefined)
    .map(String);
}

/** Значение ключа env-файла; пустое равнозначно отсутствию. */
function value(io: CleanIo, name: string): string | undefined {
  const raw = io.envFile.get(name);
  return raw === undefined || raw === "" ? undefined : raw;
}

/**
 * Обязательный ключ. Отказ слоя env-файла — доменная ошибка, а спека
 * велит отвечать на неполную конфигурацию кодом 2: переворачиваем
 * класс, сохранив текст слоя (тот же приём, что у `sql/target.ts`).
 */
function required(io: CleanIo, name: string): string {
  try {
    return io.envFile.require(name);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err), {
      cause: err,
    });
  }
}

/**
 * Первый непустой из двух ключей; второй — общий, первый — личный.
 * Цепочка та же, что у `copy-client.md`: `PG_MAIN_USER_PASSWORD →
 * PG_PASSWORD`. Читать только второй значило бы отказывать оператору,
 * у которого задан первый, как для `mpu sql`.
 */
function either(io: CleanIo, first: string, second: string): string {
  return value(io, first) ?? required(io, second);
}

/**
 * Целое из env-файла с умолчанием. Мусор в номере порта — ошибка
 * ввода, а не повод молча взять умолчание: чистка ушла бы не в тот
 * локальный PG, а оператор считал бы, что попал в заданный.
 */
function port(io: CleanIo, name: string, fallback: number): number {
  const raw = value(io, name);
  if (raw === undefined) return fallback;
  const number = Number(raw);
  if (!Number.isInteger(number) || number <= 0 || number > 65535) {
    throw new UsageError(`${name} ожидает порт 1–65535, получено "${raw}"`);
  }
  return number;
}

/** Локальный sl-1: схемы клиентов и их public-строки. */
export function sl1Target(io: CleanIo): PgTarget {
  return {
    host: LOCAL_HOST,
    port: port(io, "PG_LOCAL_PORT", 5441),
    database: value(io, "PG_DB_NAME") ?? "wb",
    username: value(io, "PG_MAIN_USER_NAME") ?? "wb_plus_db_admin",
    password: either(io, "PG_MAIN_USER_PASSWORD", "PG_PASSWORD"),
  };
}

/** Локальный sl-0: клиенты и токены. */
export function sl0Target(io: CleanIo): PgTarget {
  return { ...sl1Target(io), port: port(io, "PG_LOCAL_MAIN_PORT", 5440) };
}

/** Локальная БД воркспейсов: проводка входа в sw-front. */
export function workspacesTarget(io: CleanIo): PgTarget {
  return {
    host: LOCAL_HOST,
    port: port(io, "LOCAL_WORKSPACES_PORT", 5451),
    database: value(io, "LOCAL_WORKSPACES_DB") ?? "workspaces",
    username: value(io, "LOCAL_WORKSPACES_USER") ?? "workspacesapp",
    password: value(io, "LOCAL_WORKSPACES_PASSWORD") ?? "postgres",
  };
}

/** Ход вызова: список схем, план, затем — только с `--yes` — удаление. */
export async function runCleanLocal(
  args: CleanArgs,
  io: CleanIo,
  options: CleanOptions = {},
): Promise<CleanResult> {
  // Разбор keep-листа до подключений: `--keep abc` не стоит ни одного
  // соединения (спека, exit 2).
  const keep = parseKeep(args.keep);
  // Без `--yes` соединение открывается только на чтение: инвариант
  // «read-only без --yes» держится тогда сервером, а не дисциплиной
  // вызовов внутри команды.
  const mode = args.yes ? "write" : "read-only";
  const open = options.openSession ??
    ((target: PgTarget) => openPgSession(target, mode));

  const sl1 = await open(sl1Target(io));
  try {
    const outcome = await sl1.query(
      "SELECT nspname FROM pg_namespace WHERE nspname ~ '^schema_[0-9]+$'",
    );
    const clients = clientsOf(firstColumnAll(outcome));
    const targets = targetsOf(clients, keep);
    // Пустые цели — ранний выход: ни sl-0, ни воркспейсы не
    // открываются вовсе, даже с `--yes`.
    if (targets.length === 0 || !args.yes) {
      return {
        clients: [...clients],
        keep: [...keep],
        targets: [...targets],
        deleted: 0,
        workspaces: 0,
        dryRun: !args.yes,
      };
    }
    await sl1.run(sl1Sql(targets));
    const workspaces = await cleanTail(io, open, targets);
    return {
      clients: [...clients],
      keep: [...keep],
      targets: [...targets],
      deleted: targets.length,
      workspaces,
      dryRun: false,
    };
  } finally {
    await sl1.close();
  }
}

/** Очистка sl-0 и БД воркспейсов; возвращает число снятых проводок. */
async function cleanTail(
  io: CleanIo,
  open: OpenLocalSession,
  targets: readonly number[],
): Promise<number> {
  const sl0 = await open(sl0Target(io));
  try {
    await sl0.run(sl0Sql(targets));
  } finally {
    await sl0.close();
  }
  const workspaces = await open(workspacesTarget(io));
  try {
    return await cleanWorkspaces(workspaces, targets);
  } finally {
    await workspaces.close();
  }
}

/**
 * Проводка входа: на каждую цель ищется user по email-сигнатуре.
 * Нет user'а — цель пропускается: значит вход заводили не мы, и
 * трогать его нельзя.
 *
 * Replica-режим здесь не включается: порядок удаления явный и
 * FK-безопасный, а снимать проверки там, где они и так соблюдены,
 * значит потерять последнюю страховку от ошибки в порядке.
 */
async function cleanWorkspaces(
  session: SqlSession,
  targets: readonly number[],
): Promise<number> {
  let removed = 0;
  for (const id of targets) {
    const email = localEmail(id);
    const found = await session.query(
      `SELECT id FROM public.users WHERE email = '${email}'`,
    );
    const userId = firstColumn(found);
    if (userId === undefined) continue;
    // `userId` подставляется в текст: сессия умеет только сырой SQL, а
    // значение — uuid, только что прочитанный из этой же локальной БД.
    // Осознанное допущение, а не недосмотр.
    const owns = await session.query(
      `SELECT id FROM public.workspaces WHERE id = ${id} ` +
        `AND owner_id = '${userId}'`,
    );
    if (firstColumn(owns) !== undefined) {
      await session.run([
        `DELETE FROM public.subscriptions WHERE sid IN (SELECT sid FROM ` +
        `public.workspaces_wb_cabinets WHERE workspace_id = ${id});`,
        `DELETE FROM public.workspaces_wb_cabinets WHERE workspace_id = ${id};`,
        `DELETE FROM public.wb_cabinets WHERE workspace_id = ${id};`,
        `DELETE FROM public.workspaces WHERE id = ${id};`,
      ].join("\n"));
      removed += 1;
    }
    // User убирается в любом случае: он наш по сигнатуре, даже если
    // workspace к нему уже не привязан.
    await session.run(`DELETE FROM public.users WHERE id = '${userId}'`);
  }
  return removed;
}

/** Отчёт: план, затем итог прогона. */
export function renderCleanLocal(result: CleanResult): string {
  const head = planReport(result.clients, result.keep, result.targets);
  if (result.targets.length === 0) return `${head}${NOTHING_TAIL}\n`;
  if (result.dryRun) return `${head}${DRY_RUN_TAIL}\n`;
  return `${head}удалено клиентов: ${result.deleted}; ` +
    `снято workspace-проводок: ${result.workspaces}\n`;
}

export const cleanLocalClientsCommand = defineCommand({
  path: ["clean-local-clients"],
  errorName: "clean-local-clients",
  summary: "Снести данные локальных клиентов, кроме keep-листа.",
  usage: "mpu clean-local-clients [--keep IDS] [--yes]",
  help: `Убирает из локального стенда данные клиентов: схемы и
public-строки на sl-1, токены на sl-0, собственную проводку входа в
sw-front. Только локальные адреса — прод командой недостижим.

По умолчанию это сухой прогон: команда печатает найденных клиентов,
keep-лист и список под удаление, но ничего не трогает. Удаляет только с
--yes.

--keep — client_id через запятую, которых ОСТАВИТЬ (список инверсный);
по умолчанию 54,776. Схема shared номера клиента не имеет и под
удаление не попадает никогда. Нечисловой токен — ошибка ввода.

Снимается только та проводка входа, которую завела копия клиента: user
ищется по адресу client_<id>@local.host. Вход, заведённый вручную под
другим адресом, остаётся, даже если номер клиента совпал.

Клиент, у которого нет схемы на sl-1, в цели не попадает: множество
целей строится из схем.

Ключи env-файла: PG_PASSWORD (обязателен), PG_LOCAL_PORT (5441),
PG_LOCAL_MAIN_PORT (5440), PG_DB_NAME (wb), PG_MAIN_USER_NAME
(wb_plus_db_admin), LOCAL_WORKSPACES_PORT (5451), LOCAL_WORKSPACES_DB
(workspaces), LOCAL_WORKSPACES_USER (workspacesapp),
LOCAL_WORKSPACES_PASSWORD (postgres).

Exit: 0 — успех, в том числе когда удалять нечего; 2 — нечисловой
--keep, неполная конфигурация подключений.

Примеры: mpu clean-local-clients;
mpu clean-local-clients --keep 54,776,1234 --yes`,
  policy: "rw",
  argsSchema,
  resultSchema,
  run: (args: CleanArgs, io: CleanIo) => runCleanLocal(args, io),
  render: (result: CleanResult) => renderCleanLocal(result),
});
