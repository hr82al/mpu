/**
 * Значения ключа `target:` для дополнения (`platform/reflection.md`,
 * «Значения ключа»): клиенты, серверы `sl-N`, dev-клиенты `dev:N` — из
 * кэш-БД, без сети. Порядок и предел — у спеки: по алфавиту, не больше
 * двадцати.
 */

import { assertInitialized, type CacheReader } from "./cache.ts";
import { SelectorError } from "./error.ts";

/** Значение ключа и что за ним стоит. */
export interface TargetValue {
  readonly value: string;
  readonly purpose: string;
}

/** Больше значений дополнению не нужно: человек дописывает, а не листает. */
const LIMIT = 20;

/** Приставка dev-клиента (`platform/selector.md`). */
const DEV = "dev:";

/** Клиент кэша: номер, имя его первой таблицы и сервер. */
interface ClientRow {
  readonly id: string;
  readonly title: string;
  readonly server: string;
}

function clients(cache: CacheReader): ClientRow[] {
  return cache.query(
    "SELECT c.client_id AS id, COALESCE(MIN(s.title), '') AS title," +
      " COALESCE(c.server, '') AS server FROM sl_clients c" +
      " LEFT JOIN sl_spreadsheets s ON s.client_id = c.client_id" +
      " GROUP BY c.client_id",
  ).map((row) => ({
    id: String(row.id),
    title: String(row.title),
    server: String(row.server),
  }));
}

/** Совпадение: начало номера или подстрока имени без учёта регистра. */
function matches(client: ClientRow, like: string): boolean {
  return client.id.startsWith(like) ||
    client.title.toLowerCase().includes(like.toLowerCase());
}

function described(client: ClientRow): string {
  return [client.title, client.server].filter((part) => part !== "")
    .join(" · ");
}

/** Серверы, клиенты и dev-клиенты, подходящие к началу `like`. */
function found(rows: readonly ClientRow[], like: string): TargetValue[] {
  if (like.startsWith(DEV)) {
    const id = like.slice(DEV.length);
    return rows.filter((row) => row.id.startsWith(id))
      .map((row) => ({ value: `${DEV}${row.id}`, purpose: described(row) }));
  }
  const servers = [...new Set(rows.map((row) => row.server))]
    .filter((server) => server !== "" && server.startsWith(like))
    .map((server) => ({ value: server, purpose: "сервер" }));
  const named = rows.filter((row) => matches(row, like))
    .map((row) => ({ value: row.id, purpose: described(row) }));
  return [...servers, ...named];
}

/**
 * Значения `target:`, начинающиеся с `like` (у клиента — ещё и по
 * подстроке имени), по алфавиту, не больше двадцати. Кэш не
 * проинициализирован — значений нет: дополнение не отказывает.
 *
 * @param cache чтение кэш-БД
 * @param like набранное начало значения
 */
export function targetValues(
  cache: CacheReader,
  like: string,
): TargetValue[] {
  try {
    assertInitialized(cache);
  } catch (err) {
    // Пустой кэш — не ошибка дополнения: предложить нечего, и только.
    if (err instanceof SelectorError) return [];
    throw err;
  }
  return found(clients(cache), like)
    .sort((a, b) => a.value < b.value ? -1 : a.value > b.value ? 1 : 0)
    .slice(0, LIMIT);
}
