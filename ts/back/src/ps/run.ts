/**
 * Ход вызова `mpu ps` (`specs/ps.md`): без селектора — снапшот кэша без
 * сети, с селектором — живой список с Portainer выбранного сервера.
 * Режимы несимметричны намеренно: транзиентную строку STATUS кэш не
 * хранит, поэтому колонка есть только у живого списка.
 */

import { z } from "@zod/zod";
import {
  type CacheDb,
  type CommandIo,
  DomainError,
  UsageError,
} from "../command/mod.ts";
import { escapeLike, LIKE_ESCAPE, requirePortainer } from "../exec/mod.ts";
import {
  containerName,
  listContainers,
  PortainerError,
} from "../portainer/mod.ts";
import type { RequestTimeouts } from "../http/mod.ts";
import { type CacheReader, resolveSelector } from "../selector/mod.ts";

/**
 * Пределы HTTP-запроса (спека, «Конфигурация»): соединение — 10 секунд,
 * весь запрос — 30.
 */
const TIMEOUTS: RequestTimeouts = {
  headersTimeoutMs: 10_000,
  totalTimeoutMs: 30_000,
};

/** Порт исполнения глазами команды. */
export type PsIo = Pick<
  CommandIo,
  "envFile" | "openCacheDb" | "progress"
>;

export const argsSchema = z.object({
  selector: z.string().optional().describe(
    "sl-N или клиент-селектор; без него — снапшот кэша без сети",
  ),
  filter: z.string().optional().describe(
    "буквальная подстрока имени контейнера",
  ),
  json: z.boolean().default(false).describe("массив объектов JSON"),
  tsv: z.boolean().default(false).describe(
    "колонки через табуляцию, без шапки",
  ),
});

/** Строка вывода; `endpoint` и `status` есть не в обоих режимах. */
const containerSchema = z.object({
  /** Только кэш-режим: имя endpoint'а, `?` вместо NULL. */
  endpoint: z.string().nullable(),
  name: z.string(),
  state: z.string(),
  /** Только живой режим: транзиентная строка Docker. */
  status: z.string().nullable(),
  image: z.string(),
});

export const resultSchema = z.object({
  /** Откуда взят список: `cache` — без сети, `live` — с Portainer. */
  source: z.enum(["cache", "live"]),
  containers: z.array(containerSchema).readonly(),
});

export type PsArgs = z.infer<typeof argsSchema>;
export type PsResult = z.infer<typeof resultSchema>;
type Container = z.infer<typeof containerSchema>;

/** Подстановка живого списка: сети в тестах нет. */
export interface PsOptions {
  readonly listLive?: typeof listContainers;
}

/** Список контейнеров одного из двух источников. */
export async function runPs(
  args: PsArgs,
  io: PsIo,
  options: PsOptions = {},
): Promise<PsResult> {
  if (args.json && args.tsv) {
    throw new UsageError("--json и --tsv взаимоисключающие");
  }
  if (args.selector === undefined) {
    return { source: "cache", containers: fromCache(args.filter, io) };
  }
  return {
    source: "live",
    containers: await fromLive(args.selector, args.filter, io, options),
  };
}

/**
 * Снапшот кэша. Отсутствие таблицы и пустая выборка — разные исходы:
 * первое значит «инициализации не было» (exit 1), второе — «ферма
 * пуста», и это успех (спека, «Ввод/вывод»).
 */
function fromCache(
  filter: string | undefined,
  io: PsIo,
): readonly Container[] {
  io.progress("# кэш — запусти `mpu init` для обновления");
  using db = io.openCacheDb();
  const rows = query(db, filter);
  if (rows.length === 0) {
    io.progress("(no containers in cache — запусти `mpu init`)");
  }
  return rows;
}

function query(db: CacheDb, filter: string | undefined): readonly Container[] {
  const where = filter === undefined
    ? ""
    : ` WHERE container_name LIKE ? ESCAPE '${LIKE_ESCAPE}'`;
  const params = filter === undefined ? [] : [`%${escapeLike(filter)}%`];
  try {
    return db
      .query(
        "SELECT DISTINCT endpoint_name, container_name, state, image" +
          ` FROM portainer_containers${where}` +
          " ORDER BY endpoint_name, container_name",
        ...params,
      )
      .map((row) => ({
        // NULL endpoint'а печатается вопросом, а NULL прочих — пустым:
        // так их различает эталон канала.
        endpoint: typeof row.endpoint_name === "string"
          ? row.endpoint_name
          : "?",
        name: String(row.container_name),
        state: typeof row.state === "string" ? row.state : "",
        status: null,
        image: typeof row.image === "string" ? row.image : "",
      }));
  } catch (err) {
    // Ошибка кэш-БД — доменная (exit 1), а не пустой ответ: пустой кэш
    // и отсутствие таблицы значат разное.
    const reason = err instanceof Error ? err.message : String(err);
    throw new DomainError(
      `SQLite error: ${reason} — запусти \`mpu init\``,
      { cause: err instanceof Error ? err : undefined },
    );
  }
}

/**
 * Совпадение имени с фильтром: подстрока без учёта регистра. Регистр не
 * учитывается и в кэш-режиме (свойство `LIKE`), а один флаг одной
 * команды не может значить разное (спека, отклонение `fix`).
 *
 * Приводится к нижнему регистру только сравнение: имя контейнера уходит
 * дальше как есть — нормализованное имя, попавшее в таргеты fan-out,
 * адресовало бы несуществующий контейнер.
 *
 * Совпадение с кэш-режимом гарантировано для ASCII: `LIKE` в SQLite без
 * ICU складывает регистр только у `A-Z`, а `toLowerCase` — по всему
 * Unicode. Имена контейнеров фермы ASCII-латиница (спека, «Известные
 * отклонения»), и на них два режима отвечают одинаково.
 */
function matches(name: string, filter: string | undefined): boolean {
  return filter === undefined ||
    name.toLowerCase().includes(filter.toLowerCase());
}

/** Живой список: резолв сервера, Portainer-таргет, один GET. */
async function fromLive(
  selector: string,
  filter: string | undefined,
  io: PsIo,
  options: PsOptions,
): Promise<readonly Container[]> {
  using db = io.openCacheDb();
  const cache: CacheReader = { query: (sql, ...p) => db.query(sql, ...p) };
  const resolved = resolveSelector({ cache, env: io.envFile }, selector);
  const target = requirePortainer(io.envFile, cache, resolved.serverNumber);
  const list = options.listLive ?? listContainers;
  try {
    const containers = await list(target.access, target.endpointId, TIMEOUTS);
    return containers
      .map((container) => ({
        endpoint: null,
        name: containerName(container.names),
        state: container.state,
        status: container.status,
        image: container.image,
      }))
      .filter((container) => matches(container.name, filter))
      // Сравнение кодовых точек, а не `localeCompare`: тот зависит от
      // локали ICU и ослабляет пунктуацию, а кэш-режим сортирует
      // бинарным `ORDER BY` — порядок двух режимов обязан совпадать.
      .toSorted((left, right) => left.name < right.name ? -1 : 1);
  } catch (err) {
    if (err instanceof PortainerError) {
      throw new DomainError(`portainer error: ${err.message}`, { cause: err });
    }
    throw err;
  }
}
