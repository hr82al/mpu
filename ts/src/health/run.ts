/**
 * Ход вызова `mpu health` (`specs/health.md`): живой список контейнеров
 * сервера, их классификация и tail stderr-логов «виновников». Код
 * выхода несёт смысл: 1 ⇔ есть неожиданно не-running контейнер.
 */

import { z } from "@zod/zod";
import { type CommandIo, DomainError, UsageError } from "../command/mod.ts";
import { requirePortainer } from "../exec/mod.ts";
import type { RequestTimeouts } from "../http/mod.ts";
import {
  demuxDockerStream,
  fetchContainerLogs,
  listContainers,
  PortainerError,
} from "../portainer/mod.ts";
import { type CacheReader, resolveSelector } from "../selector/mod.ts";
import { classify, type Row } from "./classify.ts";

/**
 * Пределы HTTP (спека, «Конфигурация»): соединение — 10 секунд, список
 * целиком — 30. У запроса логов предела чтения нет: лог большого
 * контейнера приходит целиком.
 */
const LIST_TIMEOUTS: RequestTimeouts = {
  headersTimeoutMs: 10_000,
  totalTimeoutMs: 30_000,
};

const LOG_TIMEOUTS: RequestTimeouts = {
  headersTimeoutMs: 10_000,
  // Предела чтения нет: лог большого контейнера приходит целиком
  // (спека, «Конфигурация»).
  totalTimeoutMs: null,
};

/** Окно логов: `<число><s|m|h|d>` назад либо буквальный unix-ts. */
const RELATIVE = /^(\d+)([smhd])$/;
const UNIX_TS = /^\d+$/;

const SECONDS: Readonly<Record<string, number>> = {
  s: 1,
  m: 60,
  h: 3_600,
  d: 86_400,
};

/** Порт исполнения глазами команды. */
export type HealthIo = Pick<CommandIo, "envFile" | "openCacheDb">;

export const argsSchema = z.object({
  selector: z.string().describe("sl-N или клиент-селектор"),
  tail: z.number().default(30).describe("строк лога на контейнер"),
  since: z.string().optional().describe(
    "окно логов: <число>{s|m|h|d} назад либо unix-ts",
  ),
  all: z.boolean().default(false).describe(
    "tail у всех демонов, не только лоадер-подобных",
  ),
});

const rowSchema = z.object({
  name: z.string(),
  state: z.string(),
  status: z.string(),
});

const tailSchema = z.object({
  name: z.string(),
  /** stderr контейнера; пусто — окно без записей. */
  text: z.string(),
  /** Сбой получения логов; на код выхода не влияет. */
  error: z.string().nullable(),
});

export const resultSchema = z.object({
  server: z.string().describe("`sl-<N>`, к которому относится проверка"),
  rows: z.array(rowSchema).readonly(),
  /** Сколько `mp`-строк нашлось: печатается в заголовке. */
  mpCount: z.number().int(),
  oneShot: z.array(rowSchema).readonly(),
  notRunning: z.array(rowSchema).readonly(),
  tails: z.array(tailSchema).readonly(),
  tail: z.number().int().describe("значение `--tail` этого вызова"),
  exitCode: z.number().int(),
});

export type HealthArgs = z.infer<typeof argsSchema>;
export type HealthResult = z.infer<typeof resultSchema>;

/** Подстановки сети и часов: живой фермы в тестах нет. */
export interface HealthOptions {
  readonly listLive?: typeof listContainers;
  readonly fetchLogs?: typeof fetchContainerLogs;
  /** Текущий момент в unix-секундах: от него отсчитывается `--since`. */
  readonly now?: () => number;
}

/** Состояние контейнеров сервера и хвосты их stderr-логов. */
export async function runHealth(
  args: HealthArgs,
  io: HealthIo,
  options: HealthOptions = {},
): Promise<HealthResult> {
  // Валидация окна — до сетевых обращений и при каждом вызове, даже
  // когда tail-таргетов нет (отклонение `fix` спеки).
  const tail = requireTail(args.tail);
  const since = sinceOf(args.since, options.now ?? (() => Date.now() / 1000));
  using db = io.openCacheDb();
  const cache: CacheReader = { query: (sql, ...p) => db.query(sql, ...p) };
  const resolved = resolveSelector({ cache, env: io.envFile }, args.selector);
  const target = requirePortainer(io.envFile, cache, resolved.serverNumber);

  const list = options.listLive ?? listContainers;
  const health = classify(
    await portainer(() =>
      list(target.access, target.endpointId, LIST_TIMEOUTS)
    ),
    args.all,
  );
  const tails: TailResult[] = [];
  for (const row of health.tailTargets) {
    tails.push(await tailOf(row, { tail, since, target, options }));
  }
  return {
    server: `sl-${resolved.serverNumber}`,
    rows: health.rows,
    mpCount: health.mpCount,
    oneShot: health.oneShot,
    notRunning: health.notRunning,
    tails,
    tail,
    // Код выхода несёт смысл: 1 ⇔ есть неожиданно не-running
    // контейнер. Сбои получения логов его не меняют (спека).
    exitCode: health.notRunning.length > 0 ? 1 : 0,
  };
}

type TailResult = z.infer<typeof tailSchema>;

/**
 * stderr одного контейнера. Сбой по нему — строка в выводе и переход к
 * следующему: диагностическая команда не обязана падать из-за одного
 * недоступного лога (спека, п. 5).
 */
async function tailOf(
  row: Row,
  call: {
    readonly tail: number;
    readonly since: number | undefined;
    readonly target: {
      readonly access: Parameters<typeof fetchContainerLogs>[0];
      readonly endpointId: number;
    };
    readonly options: HealthOptions;
  },
): Promise<TailResult> {
  const fetch = call.options.fetchLogs ?? fetchContainerLogs;
  try {
    const bytes = await fetch(
      call.target.access,
      call.target.endpointId,
      row.name,
      {
        // Печатается только stderr: сервисы стека пишут ошибки в него, и
        // stdout утопил бы диагностику в рабочем шуме (отклонение
        // `preserve` спеки).
        stdout: false,
        stderr: true,
        tail: call.tail,
        timestamps: true,
        sinceUnix: call.since,
      },
      LOG_TIMEOUTS,
    );
    return {
      name: row.name,
      text: new TextDecoder().decode(demuxDockerStream(bytes).stderr),
      error: null,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { name: row.name, text: "", error: reason };
  }
}

/** Отказ Portainer — доменная ошибка (exit 1), со своим префиксом. */
async function portainer<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof PortainerError) {
      throw new DomainError(`portainer error: ${err.message}`, { cause: err });
    }
    throw err;
  }
}

/**
 * Значение `--tail`: целое больше нуля. Тип проверила схема, смысл —
 * здесь (`platform/command-contract.md`, «Ввод/вывод»); проверка идёт до
 * сети, как и у `--since`.
 */
function requireTail(raw: number): number {
  if (!Number.isSafeInteger(raw) || raw <= 0) {
    throw new UsageError(`--tail: ожидается целое > 0, получено '${raw}'`);
  }
  return raw;
}

/**
 * Нижняя граница окна логов в unix-секундах. Строка из одних цифр —
 * буквальный ts, а не «столько секунд назад»: `--since 90` значит
 * девяностую секунду эпохи (спека, «Граничные случаи»).
 */
function sinceOf(
  raw: string | undefined,
  now: () => number,
): number | undefined {
  if (raw === undefined) return undefined;
  if (UNIX_TS.test(raw)) return Number(raw);
  const relative = RELATIVE.exec(raw);
  if (relative === null) {
    throw new UsageError(
      `--since: ожидается <число>{s|m|h|d} или unix-ts, получено '${raw}'`,
    );
  }
  return Math.floor(now()) - Number(relative[1]) * SECONDS[relative[2]];
}
