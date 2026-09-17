/**
 * Локальный режим `mpu search` (`docs/specs/search.md`): поиск по кэш-БД
 * без сети, с одним автосинком на пустом результате.
 *
 * Предикаты и их порядок принадлежат платформе
 * (`platform/selector.md`) — здесь только то, чем поиск от резолва
 * отличается: вердикт по серверам не выносится, адреса подставляются из
 * env-файла, а пустой результат один раз пробуется догнать синком.
 */

import type { CommandIo } from "../command/mod.ts";
import {
  isServerAddressLike,
  searchCandidates,
  type SelectorSources,
} from "../selector/mod.ts";
import { rowsOf, type SearchRow } from "./row.ts";

/** Порт исполнения глазами локального режима. */
export type LocalIo = Pick<
  CommandIo,
  "envFile" | "openCacheDb" | "progress"
>;

/** Что локальный режим знает о вызове. */
export interface LocalQuery {
  readonly value: string;
  /** `--update` включён (дефолт); `--no-update` его снимает. */
  readonly update: boolean;
}

/** Итог локального поиска: строки и был ли автосинк. */
export interface LocalOutcome {
  readonly rows: readonly SearchRow[];
  readonly synced: boolean;
}

/** Догоняющий синк кэша; подменяется в тестах — живого PG у них нет. */
export type SyncCache = (io: LocalIo) => Promise<void>;

/**
 * Ищет по кэшу и, если ничего не нашлось, ровно один раз догоняет кэш
 * синком и повторяет поиск. Повторно пустой результат синк не
 * перезапускает — иначе холодный кэш давал бы два полных синка на вызов.
 *
 * Для селектора-адреса синк не запускается вовсе: адрес живёт в
 * env-файле, и обновление снапшота клиентов ему не помогает (спека,
 * «Локальный режим»).
 */
export async function searchLocal(
  query: LocalQuery,
  io: LocalIo,
  sync: SyncCache,
): Promise<LocalOutcome> {
  const first = look(query.value, io);
  if (first.length > 0) return { rows: first, synced: false };
  if (!query.update || isServerAddressLike(query.value)) {
    return { rows: first, synced: false };
  }
  await sync(io);
  return { rows: look(query.value, io), synced: true };
}

/** Один проход поиска: своё соединение с кэш-БД на каждый проход. */
function look(value: string, io: LocalIo): readonly SearchRow[] {
  using db = io.openCacheDb();
  const sources: SelectorSources = { cache: db, env: io.envFile };
  return rowsOf(searchCandidates(sources, value), io.envFile);
}
