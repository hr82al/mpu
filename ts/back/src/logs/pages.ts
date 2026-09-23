/**
 * Последние записи окна Loki страницами (`platform/long-output.md`, §2):
 * источник отдаёт на запрос не больше своего предела записей, а `limit:`
 * команды предела не имеет. Каждая следующая страница — то же окно с
 * концом у самой старой записи прошлой; записи на границе приходят
 * повторно и отбрасываются.
 */

import type { LogEntry, RangeQuery } from "../loki/mod.ts";
import { byTimeAscending } from "./render.ts";

/** Предел записей на запрос у Loki по умолчанию (`max_entries_limit_per_query`). */
export const LOKI_MAX_ENTRIES = 5000;

/** Окно запроса: LogQL и границы в наносекундах. */
export interface LokiWindow {
  readonly logql: string;
  readonly startNs: bigint;
  readonly endNs: bigint;
}

/**
 * Страницы одного окна назад от его конца: что спросить дальше, что уже
 * набрано и когда хватит — память самого объекта.
 */
export class NewestPages {
  readonly #window: LokiWindow;
  readonly #limit: number;
  readonly #pageSize: number;
  readonly #seen = new Set<string>();
  readonly #entries: LogEntry[] = [];
  #next: RangeQuery | undefined;

  /**
   * @param window окно запроса
   * @param limit сколько последних записей нужно, > 0
   * @param pageSize предел записей на запрос у источника, > 0
   */
  constructor(window: LokiWindow, limit: number, pageSize: number) {
    this.#window = window;
    this.#limit = limit;
    this.#pageSize = pageSize;
    this.#next = this.#page(window.endNs, Math.min(pageSize, limit));
  }

  /** Следующий запрос; `undefined` — набрано всё, что есть или нужно. */
  next(): RangeQuery | undefined {
    return this.#next;
  }

  /**
   * Ответ на запрос `next()`: новые записи — в набранное, увиденные
   * отбрасываются. Дальше не спрашивать, если набрано `limit`, страница
   * короче запрошенного (окно кончилось) или нового в ней нет.
   */
  take(page: readonly LogEntry[]) {
    const asked = this.#next?.limit ?? 0;
    let fresh = 0;
    for (const entry of page) {
      const key = keyOf(entry);
      if (this.#seen.has(key)) continue;
      this.#seen.add(key);
      this.#entries.push(entry);
      fresh++;
    }
    const done = fresh === 0 || page.length < asked ||
      this.#entries.length >= this.#limit;
    // Граница — самая старая запись страницы: `+ 1` держит её внутри
    // окна при любой трактовке конца у источника, а повтор отбрасывает
    // ключ записи. Страница — полная: повторы границы занимают в ней
    // место, и запрос «сколько осталось» недобирал бы.
    this.#next = done
      ? undefined
      : this.#page(oldestNs(page) + 1n, this.#pageSize);
  }

  /**
   * Последние `limit` набранных записей в порядке времени; у записей
   * одного времени — порядок ответа, как у разового запроса.
   */
  newest(): readonly LogEntry[] {
    return byTimeAscending(this.#entries).slice(-this.#limit);
  }

  #page(endNs: bigint, limit: number): RangeQuery {
    return { ...this.#window, endNs, limit, direction: "backward" };
  }
}

/**
 * Последние `limit` записей окна по возрастанию времени; ошибка любой
 * страницы — ошибка всего чтения.
 *
 * @param read один запрос к источнику
 */
export async function readNewest(
  read: (query: RangeQuery) => Promise<readonly LogEntry[]>,
  window: LokiWindow,
  limit: number,
  pageSize: number,
): Promise<readonly LogEntry[]> {
  const pages = new NewestPages(window, limit, pageSize);
  for (let query = pages.next(); query !== undefined; query = pages.next()) {
    pages.take(await read(query));
  }
  return pages.newest();
}

/** Та же запись: время, метки потока и текст. */
function keyOf(entry: LogEntry): string {
  const labels = Object.entries(entry.labels).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  return JSON.stringify([entry.tsNs, labels, entry.line]);
}

/** Наименьшее время страницы; страница непуста — иначе `take` не спросит. */
function oldestNs(page: readonly LogEntry[]): bigint {
  return page.reduce(
    (oldest, entry) => {
      const ns = BigInt(entry.tsNs);
      return ns < oldest ? ns : oldest;
    },
    BigInt(page[0].tsNs),
  );
}
