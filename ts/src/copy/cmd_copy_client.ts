/**
 * Команда `mpu copy-client` (`docs/specs/copy-client.md`): единственный
 * санкционированный мост прод → локальный стенд.
 *
 * Прод читается и только читается: дамп схемы и SELECT'ы. Пишется
 * исключительно в локальные контейнеры, чей host зашит `127.0.0.1` —
 * селектор влияет на источник и ни на что больше.
 *
 * Порядок шага 1 — дамп, потом снос цели, потом восстановление. Иначе
 * неудачный дамп оставлял бы оператора и без свежей копии, и без
 * прежней: `DROP SCHEMA … CASCADE` необратим.
 */

import { z } from "@zod/zod";
import { type CacheDb, type CommandIo, defineCommand } from "../command/mod.ts";
import {
  type CacheReader,
  requireSingleClient,
  resolveSelector,
} from "../selector/mod.ts";
import { openPgSession } from "../sql/pg.ts";
import { StatementError } from "../sql/session.ts";
import type { PgTarget } from "../sql/target.ts";
import { copyClientData, type OpenSession } from "./client_copy.ts";
import {
  clientCacheJson,
  LOCAL_PASSWORD,
  localEmail,
  seedLogin,
} from "./sw_front.ts";
import {
  localSl0,
  localSl1,
  localWorkspaces,
  sourceTarget,
} from "./targets.ts";
import {
  makeDumpFile,
  removeDumpFile,
  type RunTool,
  spawnTool,
} from "./tools.ts";

/** Временный файл дампа клиента; каталог и его права — `tools.ts`. */
function clientTempFile(): string {
  return makeDumpFile("mpu-copy-");
}

const argsSchema = z.object({
  selector: z.string({
    error: "нужен SELECTOR: client_id, spreadsheet_id или заголовок",
  }).describe("клиент: client_id, spreadsheet_id, заголовок таблицы"),
});

const countSchema = z.object({ table: z.string(), rows: z.number() });

const resultSchema = z.object({
  clientId: z.number(),
  schema: z.string(),
  sl1: z.array(countSchema).describe("перенесённые строки локального sl-1"),
  sl0: z.array(countSchema).describe("перенесённые строки локального sl-0"),
  login: z.boolean().describe("удалась ли проводка входа в sw-front"),
});

type CopyArgs = z.infer<typeof argsSchema>;
type CopyResult = z.infer<typeof resultSchema>;

/** Срез порта: кэш селектора, env-файл и печать хода. */
export type CopyIo = Pick<
  CommandIo,
  "envFile" | "openCacheDb" | "progress"
>;

/** Подстановки для тестов: живых PG и утилит у них нет. */
export interface CopyOptions {
  readonly runTool?: RunTool;
  /** Запуск `docker exec` для кэша main; без него шаг пропускается. */
  readonly runRedis?: (
    argv: readonly string[],
    stdin: string,
  ) => Promise<void>;
  readonly openSession?: OpenSession;
  readonly tempFile?: () => string;
  readonly removeFile?: (path: string) => void;
  readonly nowMs?: () => number;
}

/** Ход вызова: резолв, копия схемы, строки sl-1 и sl-0. */
export async function runCopyClient(
  args: CopyArgs,
  io: CopyIo,
  options: CopyOptions = {},
): Promise<CopyResult> {
  let db: CacheDb | undefined;
  const cache: CacheReader = {
    query: (sql, ...params) => (db ??= io.openCacheDb()).query(sql, ...params),
  };
  let clientId: number;
  let serverNumber: number;
  try {
    const resolved = resolveSelector({ cache, env: io.envFile }, args.selector);
    // Тексты отказов — платформенные: своя формулировка в каждой
    // команде разошлась бы с остальными на ровном месте.
    clientId = requireSingleClient(resolved);
    serverNumber = resolved.serverNumber;
  } finally {
    db?.[Symbol.dispose]();
  }

  io.progress(`copy-client ${clientId}: sl-${serverNumber} → локальный стенд`);
  const sl1 = localSl1(io.envFile);
  const sl0 = localSl0(io.envFile);
  const open: OpenSession = options.openSession ??
    ((target, mode) => openPgSession(target, mode));
  const counts = await copyClientData({
    progress: io.progress,
    clientId,
    source: sourceTarget(io.envFile, serverNumber),
    sl1,
    sl0,
    run: options.runTool ?? spawnTool,
    open,
    tempFile: options.tempFile ?? clientTempFile,
    removeFile: options.removeFile ?? removeDumpFile,
    nowMs: options.nowMs ?? (() => Date.now()),
  });
  // Шаги 5–6 best-effort: копия схемы и строк уже готова, и ронять её
  // из-за кэша или проводки нечего — они догоняются повторным
  // запуском (`copy-client.md`, «Инварианты»).
  await warmClientCache(io, clientId, sl0, open, options);
  const login = await seedSwFront(io, clientId, sl1, io.envFile, open);
  return {
    clientId,
    schema: `schema_${clientId}`,
    sl1: [...counts.sl1],
    sl0: [...counts.sl0],
    login,
  };
}

/** Шаг 5: строка клиента в кэш main; сбой — предупреждение. */
async function warmClientCache(
  io: CopyIo,
  clientId: number,
  sl0: PgTarget,
  open: OpenSession,
  options: CopyOptions,
): Promise<void> {
  const runRedis = options.runRedis;
  if (runRedis === undefined) return;
  try {
    const session = await open(sl0, "read-only");
    let json: string | undefined;
    try {
      json = await clientCacheJson(session, clientId);
    } finally {
      await session.close();
    }
    if (json === undefined) {
      io.progress(
        `mpu copy-client: WARN строки клиента ${clientId} нет в sl-0; ` +
          "кэш не грет",
      );
      return;
    }
    await runRedis(
      [
        "docker",
        "exec",
        "-i",
        "mp-sl-0-redis",
        "redis-cli",
        "-x",
        "SET",
        `sl-main:clients:${clientId}`,
      ],
      json,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message.split("\n")[0] : "";
    io.progress(`mpu copy-client: WARN кэш main не обновлён (${reason})`);
  }
}

/** Шаг 6: вход в локальный sw-front; сбой — предупреждение. */
async function seedSwFront(
  io: CopyIo,
  clientId: number,
  sl1: PgTarget,
  env: CopyIo["envFile"],
  open: OpenSession,
): Promise<boolean> {
  try {
    const from = await open(sl1, "read-only");
    try {
      const workspaces = await open(localWorkspaces(env), "write");
      try {
        const cabinets = await seedLogin(from, workspaces, clientId);
        io.progress(`  sw-front: кабинетов заведено ${cabinets}`);
        return true;
      } finally {
        await workspaces.close();
      }
    } finally {
      await from.close();
    }
  } catch (err) {
    const line = err instanceof Error ? err.message.split("\n")[0] : "";
    // Метка оператора — то, чего в тексте сервера может не быть вовсе:
    // «column does not exist» не называет таблицу, а операторов здесь
    // пять, и все они про разные.
    const reason = err instanceof StatementError && err.label !== undefined
      ? `${err.label}: ${line}`
      : line;
    // Текст дословно из спеки, включая префикс команды.
    io.progress(
      `mpu copy-client: WARN проводка sw-front не удалась (${reason}); ` +
        "копия в sl-1 готова",
    );
    return false;
  }
}

/** Итог: что и куда скопировано, плюс как войти в локальный sw-front. */
export function renderCopyClient(result: CopyResult): string {
  const head = `✓ client ${result.clientId}: схема + public-строки → sl-1, ` +
    `токен-строки → sl-0.\n`;
  // Строки про вход печатаются только при удавшейся проводке: обещать
  // вход, которого нет, хуже, чем промолчать (спека, «Ввод/вывод»).
  if (!result.login) return head;
  return head +
    `✓ вход: http://sw.localhost/login → ${localEmail(result.clientId)} / ` +
    `${LOCAL_PASSWORD}\n` +
    `  (workspace ${result.clientId}; если раздел просит активировать ` +
    `подписку — добавь ${result.clientId} в ` +
    `BILLING_MOCK_ACCESS_WORKSPACE_IDS фронта и пересоздай sw-front)\n`;
}

export const copyClientCommand = defineCommand({
  path: ["copy-client"],
  errorName: "copy-client",
  summary: "Скопировать клиента с прод-инстанса в локальный стенд.",
  usage: "mpu copy-client SELECTOR",
  help: `Копирует клиента с прод-инстанса в локальный стенд: схему
schema_<id> и public-строки — в локальный sl-1, токен-строки — в
локальный sl-0.

Прод только читается: дамп схемы и SELECT'ы. Пишется исключительно в
локальные контейнеры — их адрес зашит 127.0.0.1 и не настраивается,
поэтому копия не может уйти обратно в прод.

SELECTOR — client_id, подстрока spreadsheet_id или заголовка таблицы;
сервер берётся из резолва. Селектор, не сузившийся до одного client_id,
— ошибка ввода с перечнем кандидатов.

Порядок шага со схемой: сначала дамп, потом снос цели, потом
восстановление. Упавший дамп не стоит оператору прежней копии.

Локальные контейнеры стенда (mp-sl-1-pg, mp-sl-0-pg) должны быть
подняты; недоступный приёмник назван в отказе вместе с подсказкой
mpu mp-init.

По каждой таблице печатается число перенесённых строк — по ним видно,
что именно скопировалось.

Известная ловушка: pg_restore новее сервера-приёмника завершает
полностью успешное восстановление ненулевым кодом. Команда считает это
отказом, но называет последнюю ошибку инструмента, чтобы было видно,
что данные на месте.

Ключи env-файла: pg_<N> (адрес прод-инстанса), PG_PORT, PG_DB_NAME,
PG_MY_USER_NAME/PG_MAIN_USER_NAME, PG_MY_USER_PASSWORD/
PG_MAIN_USER_PASSWORD, PG_LOCAL_PORT (5441), PG_LOCAL_MAIN_PORT (5440),
PG_PASSWORD.

Exit: 0 — успех; 2 — резолв селектора, неполная конфигурация,
недоступный локальный контейнер; 1 — падение pg_dump или pg_restore.

Примеры: mpu copy-client 5175; mpu copy-client 'название магазина'`,
  policy: "rw",
  argsSchema,
  forms: { selector: { positional: "one" } },
  resultSchema,
  run: (args: CopyArgs, io: CopyIo) => runCopyClient(args, io),
  render: (result: CopyResult) => renderCopyClient(result),
});
