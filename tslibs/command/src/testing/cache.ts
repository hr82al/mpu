/**
 * Временная кэш-БД для тестов `*.test.ts`: каталог, файл БД и уборка
 * одной парой «открыть → закрыть». Нужна там, где БД живёт дольше одного
 * случая — на весь `describe` (`beforeAll` / `afterAll`), — и там, где её
 * открывала обёртка `withX` с `using`.
 *
 * Модуль подключают только тесты.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CacheDb } from "../command/mod.ts";
import { openCacheDb } from "../store/mod.ts";

/** Открытая временная кэш-БД. */
export interface TempCache {
  readonly db: CacheDb;
  /** Закрыть БД и убрать каталог — и то и другое, даже если одно упало. */
  close(): Promise<void>;
}

/**
 * Открывает кэш-БД `mpu.db` в новом временном каталоге; `prepare`
 * доводит её (схема, строки). Сбой открытия или `prepare` закрывает
 * открытое и убирает каталог, прежде чем уйти наружу.
 */
export async function openTempCache(
  prepare: (db: CacheDb) => void = () => {},
): Promise<TempCache> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  const removeDir = () => rm(dir, { recursive: true });
  let db: CacheDb | undefined;
  try {
    db = openCacheDb(`${dir}/mpu.db`);
    prepare(db);
  } catch (err) {
    db?.[Symbol.dispose]();
    await removeDir();
    throw err;
  }
  const opened = db;
  return {
    db: opened,
    close: async () => {
      try {
        opened[Symbol.dispose]();
      } finally {
        await removeDir();
      }
    },
  };
}

/**
 * Строки `node:sqlite` — записи с `null`-прототипом; `toStrictEqual`
 * отличает их от литерала `{ … }` по прототипу. Копия — те же поля на
 * обычной записи: сравнение остаётся строгим к ключам и значениям.
 */
export function plainRows<T extends Record<string, unknown>>(
  rows: readonly T[],
): T[] {
  return rows.map((row) => ({ ...row }));
}
