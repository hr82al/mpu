/**
 * Команда `mpu copy-dev` (`docs/specs/copy-dev.md`): копия с dev-стенда
 * в локальный.
 *
 * Два режима. Без аргумента — вся БД воркспейсов dev → локальный
 * `mp-sw-pg`; с client_id — та же машинерия, что у `copy-client`, но
 * источник dev, а шагов Redis и проводки sw-front нет.
 *
 * Резолв селектора здесь не выполняется намеренно: dev-клиентов в кэше
 * нет, и попытка их там искать давала бы «ничего не нашлось» вместо
 * копии. Аргумент — client_id как есть.
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand, DomainError } from "../command/mod.ts";
import { openPgSession } from "../sql/pg.ts";
import type { PgTarget } from "../sql/target.ts";
import { copyClientData, type OpenSession } from "./client_copy.ts";
import {
  devSourceTarget,
  devWorkspacesTarget,
  localSl0,
  localSl1,
  localWorkspaces,
} from "./targets.ts";
import {
  dumpDatabaseArgs,
  makeDumpFile,
  removeDumpFile,
  restoreDatabaseArgs,
  type RunTool,
  runTool,
  spawnTool,
  toolFailure,
} from "./tools.ts";

/** Временный файл дампа dev-БД; каталог и его права — `tools.ts`. */
function devTempFile(): string {
  return makeDumpFile("mpu-copy-dev-");
}

const argsSchema = z.object({
  client: z.number().int().positive().optional().describe(
    "client_id на dev; без него копируется вся БД воркспейсов",
  ),
});

const resultSchema = z.object({
  mode: z.enum(["workspaces", "client"]).describe("что копировалось"),
  clientId: z.union([z.number(), z.null()]),
});

type DevArgs = z.infer<typeof argsSchema>;
type DevResult = z.infer<typeof resultSchema>;

/** Срез порта: env-файл и печать хода. */
export type DevIo = Pick<CommandIo, "envFile" | "progress">;

/** Подстановки для тестов. */
export interface DevOptions {
  readonly runTool?: RunTool;
  readonly openSession?: OpenSession;
  readonly tempFile?: () => string;
  readonly removeFile?: (path: string) => void;
  readonly nowMs?: () => number;
}

/** Ход вызова: режим полной БД либо режим клиента. */
export async function runCopyDev(
  args: DevArgs,
  io: DevIo,
  options: DevOptions = {},
): Promise<DevResult> {
  if (args.client === undefined) {
    await copyWorkspaces(io, options);
    return { mode: "workspaces", clientId: null };
  }
  await copyDevClient(io, args.client, options);
  return { mode: "client", clientId: args.client };
}

/** Режим полной БД: дамп dev-воркспейсов, восстановление в mp-sw-pg. */
async function copyWorkspaces(io: DevIo, options: DevOptions): Promise<void> {
  const source = devWorkspacesTarget(io.envFile);
  const target = localWorkspaces(io.envFile);
  const run = options.runTool ?? spawnTool;
  const nowMs = options.nowMs ?? (() => Date.now());
  const file = (options.tempFile ?? devTempFile)();
  const remove = options.removeFile ?? removeDumpFile;
  try {
    const dumpArgv = dumpDatabaseArgs(source, file);
    io.progress(`$ ${dumpArgv.join(" ")}`);
    const dump = await runTool(run, dumpArgv, source, io.progress, nowMs);
    if (dump.code !== 0) {
      throw new DomainError(toolFailure("pg_dump", "workspaces", dump));
    }
    // `--clean --if-exists` сносит объекты локальной БД перед
    // восстановлением: это назначение команды, а не побочный эффект.
    const restoreArgv = restoreDatabaseArgs(target, file);
    io.progress(`$ ${restoreArgv.join(" ")}`);
    const restore = await runTool(run, restoreArgv, target, io.progress, nowMs);
    if (restore.code !== 0) {
      throw new DomainError(toolFailure("pg_restore", "workspaces", restore));
    }
  } finally {
    remove(file);
  }
}

/** Режим клиента: та же машинерия, что у `copy-client`, но с dev. */
async function copyDevClient(
  io: DevIo,
  clientId: number,
  options: DevOptions,
): Promise<void> {
  const source = devSourceTarget(io.envFile);
  const open = options.openSession ??
    ((target: PgTarget, mode: "read-only" | "write") =>
      openPgSession(target, mode));
  await copyClientData({
    progress: io.progress,
    clientId,
    source,
    sl1: localSl1(io.envFile),
    sl0: localSl0(io.envFile),
    run: options.runTool ?? spawnTool,
    open,
    tempFile: options.tempFile ?? devTempFile,
    removeFile: options.removeFile ?? removeDumpFile,
    nowMs: options.nowMs ?? (() => Date.now()),
  });
}

/** Итог: что скопировано и что делать дальше. */
export function renderCopyDev(result: DevResult): string {
  if (result.mode === "client") {
    return `✓ client ${result.clientId}: схема + public-строки → sl-1, ` +
      "токен-строки → sl-0. Данные готовы (пересчёт не нужен). " +
      "При залипшем кэше: docker exec redis-dev redis-cli " +
      "-a some-redis-password FLUSHALL\n";
  }
  return "✓ workspaces скопирована в локальный mp-sw-pg. " +
    "Перезапусти api (`sw-back-up`) — entrypoint накатит " +
    "prisma migrate deploy.\n";
}

export const copyDevCommand = defineCommand({
  path: ["copy-dev"],
  errorName: "copy-dev",
  summary: "Скопировать данные с dev-стенда в локальный.",
  usage: "mpu copy-dev [CLIENT_ID]",
  help: `Без аргумента копирует всю БД воркспейсов с dev в локальный
mp-sw-pg: существующие объекты локальной БД сносятся перед
восстановлением — это назначение команды, подтверждения она не
спрашивает.

С аргументом копирует клиента: схему schema_<id> и public-строки в
локальный sl-1, токен-строки в локальный sl-0. Машинерия та же, что у
mpu copy-client, но источник — dev, а Redis-кэша и проводки sw-front
здесь нет.

CLIENT_ID трактуется как номер клиента напрямую: резолв селектора не
выполняется и кэш не читается, потому что dev-клиентов в нём нет.

Dev-стенд только читается; запись идёт исключительно в локальные
контейнеры, их адрес зашит 127.0.0.1.

Ключи env-файла: DEV_PG_HOST (192.168.150.40), DEV_PG_PORT (5434),
DEV_PG_DB (mp_sl_1_dev), DEV_PG_USER/PG_MAIN_USER_NAME,
DEV_PG_PASSWORD/PG_PASSWORD; DEV_WORKSPACES_HOST (192.168.150.41),
DEV_WORKSPACES_PORT (5432), DEV_WORKSPACES_DB (workspaces),
DEV_WORKSPACES_USER и DEV_WORKSPACES_PASSWORD — обязательны, fallback'ов
у них нет.

Exit: 0 — успех; 2 — нецелый аргумент, неполная конфигурация,
недоступный локальный контейнер; 1 — падение pg_dump или pg_restore.

Примеры: mpu copy-dev; mpu copy-dev 776`,
  policy: "rw",
  argsSchema,
  forms: { client: { positional: "one" } },
  resultSchema,
  run: (args: DevArgs, io: DevIo) => runCopyDev(args, io),
  render: (result: DevResult) => renderCopyDev(result),
});
