/**
 * Раскрытые узлы дерева — только интерфейсное, в `localStorage`. Хранилище
 * может быть недоступно (приватное окно, запрет) — тогда без памяти.
 */

const KEY = "mpu-web:expanded";

/** Раскрытые узлы из хранилища; не читается — пусто. */
export function loadExpanded(storage: Storage | undefined): Set<string> {
  try {
    const text = storage?.getItem(KEY);
    const keys: unknown = text === null || text === undefined
      ? []
      : JSON.parse(text);
    return new Set(
      Array.isArray(keys) ? keys.filter((one) => typeof one === "string") : [],
    );
  } catch {
    // Хранилище недоступно или испорчено — раскрытые узлы не помнятся.
    return new Set();
  }
}

/** Сохраняет раскрытые узлы; не пишется — не страшно. */
export function saveExpanded(
  storage: Storage | undefined,
  keys: ReadonlySet<string>,
) {
  try {
    storage?.setItem(KEY, JSON.stringify([...keys]));
  } catch {
    // Запись запрещена или место кончилось — это только удобство.
  }
}
