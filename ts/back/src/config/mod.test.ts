/**
 * Тесты предпочтений (`platform/config.md`): источник — таблицы
 * `config` и `xlsx_aliases` кэш-БД, а не файл. База настоящая, во
 * временном каталоге: подделка таблицы прошла бы мимо ровно того
 * дефекта, ради которого хранилище переехало, — «читаем не оттуда, и
 * молча получаются умолчания».
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { plainRows } from "../testing/cache.ts";
import { thrown } from "../testing/thrown.ts";
import { type CacheDb, DomainError } from "../command/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import {
  aliases,
  aliasPath,
  configValue,
  readPreferences,
  removeAlias,
  setAlias,
  setConfigValue,
  unsetConfigValue,
} from "./mod.ts";

/** Прогон с настоящей БД во временном каталоге. */
async function withDb(body: (db: CacheDb) => void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    body(db);
  } finally {
    await rm(dir, { recursive: true });
  }
}

it("configValue: отсутствующая таблица равнозначна пустой", () =>
  withDb((db) => {
    // Ни bootstrap, ни `mpu init` перед чтением: `platform/config.md`,
    // «Граничные случаи».
    expect(configValue(db, "sheet.default")).toStrictEqual(undefined);
    expect(aliasPath(db, "otchet")).toStrictEqual(undefined);
    expect(aliases(db)).toStrictEqual([]);
  }));

it("setConfigValue: запись создаёт таблицу и видна чтением", () =>
  withDb((db) => {
    setConfigValue(db, "xlsx.default", "007");
    // Значение хранится буквально: «007» не нормализуется в 7.
    expect(configValue(db, "xlsx.default")).toBe("007");
    setConfigValue(db, "xlsx.default", "/o.xlsx");
    expect(configValue(db, "xlsx.default"), "upsert").toBe("/o.xlsx");
    setConfigValue(db, "sheet.default", "4326");
    expect(configValue(db, "sheet.default"), "ключи не мешают").toBe("4326");
  }));

it("configValue: значение лежит в таблице config кэш-БД", () =>
  withDb((db) => {
    setConfigValue(db, "sheet.default", "4326");
    // Прямой запрос, а не через модуль: таблицу делят обе реализации,
    // и разойтись им нельзя (`platform/config.md`, «Инварианты»).
    expect(plainRows(db.query("SELECT key, value FROM config"))).toStrictEqual([
      {
        key: "sheet.default",
        value: "4326",
      },
    ]);
  }));

it("unsetConfigValue: идемпотентно, пустое значение — как нет", () =>
  withDb((db) => {
    setConfigValue(db, "sheet.cache.tab_ttl", "7777");
    unsetConfigValue(db, "sheet.cache.tab_ttl");
    expect(configValue(db, "sheet.cache.tab_ttl")).toStrictEqual(undefined);
    unsetConfigValue(db, "sheet.cache.tab_ttl");
    expect(configValue(db, "sheet.cache.tab_ttl")).toStrictEqual(undefined);
    setConfigValue(db, "sheet.cache.tab_ttl", "");
    expect(configValue(db, "sheet.cache.tab_ttl"), "пустое — умолчание")
      .toStrictEqual(undefined);
  }));

it("алиасы: upsert, алфавитный порядок, удаление по факту", () =>
  withDb((db) => {
    setAlias(db, "б", "/b.xlsx", 1000);
    setAlias(db, "а", "/a.xlsx", 1001);
    expect(aliases(db)).toStrictEqual([
      { name: "а", path: "/a.xlsx" },
      { name: "б", path: "/b.xlsx" },
    ]);
    setAlias(db, "а", "~/a2.xlsx", 1002);
    expect(aliasPath(db, "а"), "путь как ввели").toBe("~/a2.xlsx");
    expect(aliases(db).length, "upsert, а не второй ряд").toBe(2);
    expect(removeAlias(db, "а")).toBe(true);
    expect(removeAlias(db, "а"), "второй раз — записи не было").toBe(false);
    expect(aliases(db)).toStrictEqual([{ name: "б", path: "/b.xlsx" }]);
  }));

it("битая таблица не выдаётся за пустую", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    // Форма другой версии: базу делят обе реализации, и `bootstrap`
    // (`CREATE … IF NOT EXISTS`) чужую таблицу не чинит. Молчаливое
    // «ключа нет» здесь означало бы запуск не того бинаря и потерю
    // алиасов — то же самое, что уже случилось с несуществовавшим
    // файлом (`platform/store.md`, «Граничные случаи»).
    db.execute("CREATE TABLE config (key TEXT PRIMARY KEY, val TEXT)");
    expect(() => configValue(db, "sheet.default")).toThrow();
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("readPreferences: нет пути к БД — умолчания; прочий отказ наружу", () => {
  // Хранилища нет вовсе (не задан HOME): вызов, целиком определённый
  // флагом, обязан работать и в cron, и в контейнере — умолчания
  // вместо падения (`platform/config.md`, «Граничные случаи»).
  const noHome = {
    openCacheDb: (): CacheDb => {
      throw new DomainError("путь к кэш-БД не определён: HOME не задан");
    },
  };
  expect(readPreferences(noHome, (db) => db.path, "умолчание")).toBe(
    "умолчание",
  );
  // А вот отказ открытия по другой причине (повреждённый файл, права)
  // глотать нельзя: молчаливые умолчания — тот самый дефект.
  const broken = {
    openCacheDb: (): CacheDb => {
      throw new Error("database disk image is malformed");
    },
  };
  thrown(
    () => readPreferences(broken, (db) => db.path, "умолчание"),
    Error,
    "malformed",
  );
});
