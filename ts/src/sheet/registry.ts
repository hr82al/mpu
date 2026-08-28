/**
 * Локальный реестр таблиц (`docs/specs/sheet-registry.md`): алиасы
 * коротких имён. Наполнение `sl_spreadsheets` командой `sync` — не
 * здесь: у неё сеть и замена реестра целиком, и приедет она отдельно.
 *
 * Таблица `sheet_aliases` заводится общим bootstrap'ом (`src/store`);
 * её отсутствие — не ошибка, а свежая БД: у резолва оно уже значит
 * «алиасов нет» (`sources.ts`), и здесь значит то же.
 */

import type { CacheDb } from "../command/mod.ts";
import { isMissingTable } from "../store/mod.ts";

/** Строка реестра алиасов в порядке вывода. */
export interface AliasRow {
  readonly name: string;
  readonly ss_id: string;
}

/** Все алиасы по имени; таблицы нет — пустая выдача, а не отказ. */
export function aliasRows(db: CacheDb): readonly AliasRow[] {
  try {
    return db.query("SELECT name, ss_id FROM sheet_aliases ORDER BY name")
      .map((row) => ({ name: String(row.name), ss_id: String(row.ss_id) }));
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

/** `ss_id` алиаса; имени нет — `undefined`. */
export function aliasSsId(db: CacheDb, name: string): string | undefined {
  try {
    const value = db.query(
      "SELECT ss_id FROM sheet_aliases WHERE name = ?",
      name,
    )[0]?.ss_id;
    return typeof value === "string" ? value : undefined;
  } catch (err) {
    if (isMissingTable(err)) return undefined;
    throw err;
  }
}

/**
 * Заведение поверх существующего имени обновляет `ss_id`, не заводя
 * второй строки (`sheet-registry.md`, «Хранилище»): имя — первичный
 * ключ, и upsert здесь не оптимизация, а сам контракт.
 */
export function setAlias(
  db: CacheDb,
  name: string,
  ssId: string,
  nowSeconds: number,
): void {
  db.execute(
    "INSERT INTO sheet_aliases (name, ss_id, created_at)" +
      " VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET" +
      " ss_id = excluded.ss_id",
    name,
    ssId,
    nowSeconds,
  );
}

/**
 * Снятие алиаса; `false` — имени не было. Величина снята с результата
 * самого удаления, а не с чтения до него (`ts/CLAUDE.md`, «Величина
 * берётся там, где совершается работа»): по ней команда и различает
 * два исхода, которых спека требует разных (инвариант 5).
 */
export function removeAlias(db: CacheDb, name: string): boolean {
  try {
    return db.execute("DELETE FROM sheet_aliases WHERE name = ?", name) > 0;
  } catch (err) {
    if (isMissingTable(err)) return false;
    throw err;
  }
}
