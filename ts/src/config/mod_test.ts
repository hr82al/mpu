/**
 * Тесты предпочтений (`platform/config.md`): источник — таблицы
 * `config` и `xlsx_aliases` кэш-БД, а не файл. База настоящая, во
 * временном каталоге: подделка таблицы прошла бы мимо ровно того
 * дефекта, ради которого хранилище переехало, — «читаем не оттуда, и
 * молча получаются умолчания».
 */

import { assertEquals, assertThrows } from "@std/assert";
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
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    body(db);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("configValue: отсутствующая таблица равнозначна пустой", () =>
  withDb((db) => {
    // Ни bootstrap, ни `mpu init` перед чтением: `platform/config.md`,
    // «Граничные случаи».
    assertEquals(configValue(db, "sheet.default"), undefined);
    assertEquals(aliasPath(db, "otchet"), undefined);
    assertEquals(aliases(db), []);
  }));

Deno.test("setConfigValue: запись создаёт таблицу и видна чтением", () =>
  withDb((db) => {
    setConfigValue(db, "xlsx.default", "007");
    // Значение хранится буквально: «007» не нормализуется в 7.
    assertEquals(configValue(db, "xlsx.default"), "007");
    setConfigValue(db, "xlsx.default", "/o.xlsx");
    assertEquals(configValue(db, "xlsx.default"), "/o.xlsx", "upsert");
    setConfigValue(db, "sheet.default", "4326");
    assertEquals(configValue(db, "sheet.default"), "4326", "ключи не мешают");
  }));

Deno.test("configValue: значение лежит в таблице config кэш-БД", () =>
  withDb((db) => {
    setConfigValue(db, "sheet.default", "4326");
    // Прямой запрос, а не через модуль: таблицу делят обе реализации,
    // и разойтись им нельзя (`platform/config.md`, «Инварианты»).
    assertEquals(
      db.query("SELECT key, value FROM config"),
      [{ key: "sheet.default", value: "4326" }],
    );
  }));

Deno.test("unsetConfigValue: идемпотентно, пустое значение — как нет", () =>
  withDb((db) => {
    setConfigValue(db, "mcp.port", "7777");
    unsetConfigValue(db, "mcp.port");
    assertEquals(configValue(db, "mcp.port"), undefined);
    unsetConfigValue(db, "mcp.port");
    assertEquals(configValue(db, "mcp.port"), undefined);
    setConfigValue(db, "mcp.port", "");
    assertEquals(configValue(db, "mcp.port"), undefined, "пустое — умолчание");
  }));

Deno.test("алиасы: upsert, алфавитный порядок, удаление по факту", () =>
  withDb((db) => {
    setAlias(db, "б", "/b.xlsx", 1000);
    setAlias(db, "а", "/a.xlsx", 1001);
    assertEquals(aliases(db), [
      { name: "а", path: "/a.xlsx" },
      { name: "б", path: "/b.xlsx" },
    ]);
    setAlias(db, "а", "~/a2.xlsx", 1002);
    assertEquals(aliasPath(db, "а"), "~/a2.xlsx", "путь как ввели");
    assertEquals(aliases(db).length, 2, "upsert, а не второй ряд");
    assertEquals(removeAlias(db, "а"), true);
    assertEquals(removeAlias(db, "а"), false, "второй раз — записи не было");
    assertEquals(aliases(db), [{ name: "б", path: "/b.xlsx" }]);
  }));

Deno.test("битая таблица не выдаётся за пустую", async () => {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    // Форма другой версии: базу делят обе реализации, и `bootstrap`
    // (`CREATE … IF NOT EXISTS`) чужую таблицу не чинит. Молчаливое
    // «ключа нет» здесь означало бы запуск не того бинаря и потерю
    // алиасов — то же самое, что уже случилось с несуществовавшим
    // файлом (`platform/store.md`, «Граничные случаи»).
    db.execute("CREATE TABLE config (key TEXT PRIMARY KEY, val TEXT)");
    assertThrows(() => configValue(db, "sheet.default"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readPreferences: нет пути к БД — умолчания; прочий отказ наружу", () => {
  // Хранилища нет вовсе (не задан HOME): вызов, целиком определённый
  // флагом, обязан работать и в cron, и в контейнере — умолчания
  // вместо падения (`platform/config.md`, «Граничные случаи»).
  const noHome = {
    openCacheDb: (): CacheDb => {
      throw new DomainError("путь к кэш-БД не определён: HOME не задан");
    },
  };
  assertEquals(
    readPreferences(noHome, (db) => db.path, "умолчание"),
    "умолчание",
  );
  // А вот отказ открытия по другой причине (повреждённый файл, права)
  // глотать нельзя: молчаливые умолчания — тот самый дефект.
  const broken = {
    openCacheDb: (): CacheDb => {
      throw new Error("database disk image is malformed");
    },
  };
  assertThrows(
    () => readPreferences(broken, (db) => db.path, "умолчание"),
    Error,
    "malformed",
  );
});
