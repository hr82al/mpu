/**
 * Разбор живого списка контейнеров сервера (`specs/health.md`, п. 1-5):
 * что считать `mp`-строкой, что — штатно завершённым one-shot'ом, а что
 * — поводом для exit 1.
 */

import { containerName, type PortainerContainer } from "../portainer/mod.ts";

/**
 * Имя `mp`-строки: `sl-` или `wb-`, префикс `mp-` перед ними
 * необязателен — обе формы живут на ферме одновременно, и без второй
 * таблица теряет большинство контейнеров, а код выхода перестаёт
 * что-либо значить (спека, п. 1).
 */
const MP_NAME = /^(?:mp-)?(?:sl-|wb-)/;

/** Ключевые слова one-shot контейнеров (без учёта регистра). */
const ONE_SHOT = ["migrations", "init-"];

/** Штатное завершение one-shot'а: код ноль. */
const COMPLETED = "Exited (0)";

/** Демоны, чей stderr показывают по умолчанию (спека, п. 5). */
const LOADER_LIKE = [
  "loader",
  "data-processor",
  "ss-updater",
  "ss-loader",
  "ss-jobs",
  "nats-listeners",
  "workers",
  "instance-app",
  "main-app",
];

/** Контейнер глазами health: только то, что участвует в разборе. */
export interface Row {
  readonly name: string;
  readonly state: string;
  readonly status: string;
}

/** Разобранный список: что в таблицу, что в блоки, у кого брать логи. */
export interface Health {
  /** Строки таблицы состояний. */
  readonly rows: readonly Row[];
  /** Сколько `mp`-строк нашлось; в заголовке печатается оно. */
  readonly mpCount: number;
  readonly oneShot: readonly Row[];
  /** Неожиданно не-running: ровно они дают exit 1. */
  readonly notRunning: readonly Row[];
  /** У кого запрашивать stderr. */
  readonly tailTargets: readonly Row[];
}

/** Разбирает живой список; `all` — брать логи у всех демонов. */
export function classify(
  containers: readonly PortainerContainer[],
  all: boolean,
): Health {
  const named = containers
    .map((container) => ({
      name: containerName(container.names),
      state: container.state,
      status: container.status,
    }))
    .filter((row) => row.name !== "")
    // Сравнение кодовых точек: `localeCompare` зависит от локали ICU и
    // ослабляет пунктуацию, а таблица обязана быть одинаковой везде.
    .toSorted((left, right) => left.name < right.name ? -1 : 1);
  const mp = named.filter((row) => MP_NAME.test(row.name));

  const oneShot = mp.filter(isOneShot);
  const notRunning = mp.filter((row) =>
    row.state !== "running" && !isOneShot(row)
  );
  const daemons = mp.filter((row) => !hasOneShotName(row.name));
  return {
    // При нуле `mp`-строк таблица печатает всё, что есть на endpoint'е:
    // диагностической команде это полезнее пустой таблицы (отклонение
    // `preserve` спеки).
    rows: mp.length === 0 ? named : mp,
    mpCount: mp.length,
    oneShot,
    notRunning,
    tailTargets: all ? daemons : daemons.filter(isLoaderLike),
  };
}

/**
 * Штатно завершённый one-shot: имя по ключевым словам, состояние
 * `exited` и нулевой код в статусе. `Exited (1)` под правило не
 * подходит — он идёт в блок предупреждений и даёт exit 1 (спека).
 */
function isOneShot(row: Row): boolean {
  return hasOneShotName(row.name) && row.state === "exited" &&
    row.status.startsWith(COMPLETED);
}

function hasOneShotName(name: string): boolean {
  const lower = name.toLowerCase();
  return ONE_SHOT.some((word) => lower.includes(word));
}

function isLoaderLike(row: Row): boolean {
  const lower = row.name.toLowerCase();
  return LOADER_LIKE.some((word) => lower.includes(word));
}
