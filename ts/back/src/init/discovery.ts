/**
 * Чистая классификация контейнеров Portainer (`docs/specs/init.md`,
 * шаг 2): выводит отображаемое имя контейнера и номер sl-сервера из его
 * docker-имён. Модуль не знает ни о Portainer, ни о кэш-БД, ни о
 * конкретном контейнере целиком — только о правиле разбора имени, и
 * поэтому проверяется без сети и без файлов.
 */

/** `sl-N-cli`, опционально с ведущим `/` и префиксом `mp-`; N включает 0. */
const SL_NAME = /^\/?(?:mp-)?sl-(\d+)-cli$/;

/** Итог классификации: то, что нужно записи кэша и сводке шага 2. */
export interface ClassifiedContainer {
  /** Первое из docker-имён без ведущего `/`. */
  readonly containerName: string;
  /** Номер sl-сервера из любого docker-имени; у прочих контейнеров — null. */
  readonly serverNumber: number | null;
}

/**
 * Классифицирует контейнер по его docker-именам. `containerName` берётся
 * из первого имени; `serverNumber` — из первого имени в списке, которое
 * матчится `SL_NAME` (порядок имён внутри списка не специфицирован
 * протоколом, поэтому подходит любое совпадение).
 */
export function classifyContainer(
  names: readonly string[],
): ClassifiedContainer {
  const first = names[0] ?? "";
  const match = names.map((name) => SL_NAME.exec(name)).find((m) => m !== null);
  return {
    containerName: first.startsWith("/") ? first.slice(1) : first,
    serverNumber: match === undefined ? null : Number(match[1]),
  };
}
