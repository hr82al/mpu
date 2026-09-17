/**
 * Локальные предпочтения CLI (`platform/config.md`): значения ключей
 * реестра и именованные алиасы файлов команды `xlsx`.
 *
 * Источник один — таблицы `config` и `xlsx_aliases` кэш-БД
 * `~/.config/mpu/mpu.db` (`platform/store.md`). Отдельного файла
 * предпочтений не существует: базу делят обе реализации, и разойтись
 * им нельзя. Чтение по файловому пути — дефект, а не альтернативная
 * форма; так уже случилось однажды, и молча отдавались умолчания.
 */

import {
  type CacheDb,
  type CommandIo,
  DomainError,
  type SqlRow,
} from "../command/mod.ts";
import { isMissingTable } from "../store/mod.ts";

/** Алиас файла: имя и путь, как его ввели. */
export interface Alias {
  readonly name: string;
  readonly path: string;
}

/**
 * Читает предпочтения там, где кэш-БД ещё не открыта: открывает,
 * отдаёт `read` и закрывает.
 *
 * Недостижимое хранилище (пути к файлу нет вовсе — не задан HOME)
 * равнозначно пустому: `platform/config.md` велит в его отсутствие
 * работать по умолчаниям, и вызов, целиком определённый флагом, не
 * должен падать из-за отсутствия HOME (cron, systemd-юнит,
 * контейнер). Прочие отказы открытия — повреждённый файл, права — не
 * глотаются: доменной ошибкой атом отвечает ровно на «пути нет»
 * (`platform/store.md`).
 */
export function readPreferences<T>(
  io: Pick<CommandIo, "openCacheDb">,
  read: (db: CacheDb) => T,
  whenUnavailable: T,
): T {
  let opened: CacheDb;
  try {
    opened = io.openCacheDb();
  } catch (err) {
    if (err instanceof DomainError) return whenUnavailable;
    throw err;
  }
  using db = opened;
  return read(db);
}

/**
 * Значение ключа предпочтений; записи нет либо она пуста —
 * `undefined`, и действует умолчание потребителя.
 */
export function configValue(db: CacheDb, key: string): string | undefined {
  const rows = read(db, "SELECT value FROM config WHERE key = ?", key);
  const value = rows[0]?.value;
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Записывает значение ключа; таблицы нет — она создаётся. */
export function setConfigValue(
  db: CacheDb,
  key: string,
  value: string,
): void {
  db.bootstrap();
  db.execute(
    "INSERT INTO config (key, value) VALUES (?, ?)" +
      " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    value,
  );
}

/** Удаляет значение ключа; записи не было — тоже успех. */
export function unsetConfigValue(db: CacheDb, key: string): void {
  db.bootstrap();
  db.execute("DELETE FROM config WHERE key = ?", key);
}

/** Путь алиаса; алиаса нет — `undefined`. */
export function aliasPath(db: CacheDb, name: string): string | undefined {
  const rows = read(db, "SELECT path FROM xlsx_aliases WHERE name = ?", name);
  const path = rows[0]?.path;
  return typeof path === "string" ? path : undefined;
}

/** Все алиасы по имени: порядок — алфавитный, как в выводе `alias ls`. */
export function aliases(db: CacheDb): readonly Alias[] {
  return read(db, "SELECT name, path FROM xlsx_aliases ORDER BY name")
    .map((row) => ({ name: String(row.name), path: String(row.path) }));
}

/** Добавляет или заменяет алиас; таблицы нет — она создаётся. */
export function setAlias(
  db: CacheDb,
  name: string,
  path: string,
  nowSeconds: number,
): void {
  db.bootstrap();
  db.execute(
    "INSERT INTO xlsx_aliases (name, path, created_at) VALUES (?, ?, ?)" +
      " ON CONFLICT(name) DO UPDATE SET path = excluded.path",
    name,
    path,
    nowSeconds,
  );
}

/** Удаляет алиас; возвращает `true`, если запись была. */
export function removeAlias(db: CacheDb, name: string): boolean {
  db.bootstrap();
  return db.execute("DELETE FROM xlsx_aliases WHERE name = ?", name) > 0;
}

/**
 * Чтение таблицы предпочтений. Пустотой отвечает **только**
 * отсутствующая таблица: `mpu init` для чтения не требуется
 * (`platform/config.md`, «Граничные случаи»). Любая другая ошибка
 * SQLite уходит наружу — так велит `platform/store.md` («файл
 * повреждён → ошибка пробрасывается потребителю»), и так не
 * повторяется дефект, ради которого предпочтения сюда и переехали:
 * молчаливые умолчания вместо признания, что прочитать не удалось.
 */
function read(
  db: CacheDb,
  sql: string,
  ...params: readonly string[]
): readonly SqlRow[] {
  try {
    return db.query(sql, ...params);
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}
