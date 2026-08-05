/**
 * Атом локальной кэш-БД (`docs/specs/platform/store.md`): открытие
 * SQLite-файла, идемпотентный bootstrap схемы, транзакции. Домен таблиц —
 * дело потребителей (`src/command/mod.ts` объявляет интерфейс `CacheDb`
 * на своей стороне); этот модуль знает только DDL (`schema.ts`) и как
 * безопасно открыть и писать в файл.
 *
 * Единственная зависимость — встроенный в Deno `node:sqlite`
 * (`DatabaseSync`, prepared statements): решение зафиксировано проектом
 * реализации порции А, своего пакета не требует (`ts/CLAUDE.md`,
 * «Библиотеки и приёмы» — предпочтение встроенным API Deno).
 */

import { DatabaseSync } from "node:sqlite";
import type { CacheDb, SqlRow } from "../command/mod.ts";
import { SCHEMA_STATEMENTS } from "./schema.ts";

/**
 * Открывает кэш-БД по пути файла: создаёт недостающий каталог и
 * подключается к SQLite. Схему не создаёт — открытие само по себе не
 * пишет (`platform/store.md`: «открытие БД на чтение схему не создаёт»);
 * для схемы вызывающий явно зовёт `bootstrap()`.
 */
export function openCacheDb(path: string): CacheDb {
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir !== "") Deno.mkdirSync(dir, { recursive: true });

  // Недостающий файл создаётся сразу с 0600 (в БД лежат токены доступа) —
  // ДО открытия SQLite: движок копирует права главного файла на служебные
  // -wal/-shm при их появлении, поэтому окна с широкими правами у спутников
  // не возникает (`platform/store.md`, «Ввод/вывод»). Уже существующий файл
  // не трогаем — его права приводит `bootstrap()`.
  try {
    Deno.openSync(path, { createNew: true, write: true, mode: 0o600 })
      .close();
  } catch (err) {
    if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
  }

  const db = new DatabaseSync(path);
  try {
    // Персистентный в файле БД режим (`platform/store.md`, «Ввод/вывод»):
    // конкурентные вызовы `mpu`, включая параллельную Python-реализацию,
    // читают и пишут без взаимной блокировки.
    db.exec("PRAGMA journal_mode=WAL");
  } catch (err) {
    // Повреждённый файл (`platform/store.md`, «Граничные случаи»): `exec`
    // бросает уже после того, как хендл открыт — без закрытия он остаётся
    // висеть навсегда, потому что `CacheDb` с его `[Symbol.dispose]` ещё
    // не создан. Ошибку не подменяем — пробрасываем исходную.
    db.close();
    throw err;
  }

  return {
    path,
    bootstrap: () => {
      // Каждый оператор — `CREATE … IF NOT EXISTS`: повторный вызов на
      // живой БД ничего не меняет, недостающие объекты досоздаются
      // независимо от прочих (без внешних ключей порядок не важен).
      for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
      // Вторая половина контракта прав (`platform/store.md`, «Ввод/вывод»):
      // только что созданный файл уже 0600 благодаря `openCacheDb`, а
      // уже существующий файл мог достаться с более широкими правами
      // (например, от версии до этого вердикта, или созданный
      // Python-оригиналом, который прав не выставляет) — bootstrap
      // приводит его к 0600.
      Deno.chmodSync(path, 0o600);
    },
    execute: (sql, ...params) => Number(db.prepare(sql).run(...params).changes),
    query: (sql, ...params) =>
      // node:sqlite типизирует столбцы шире домена (допускает bigint при
      // переполнении числа), но по умолчанию (`readBigInts: false`,
      // здесь не переопределяется) переполнение бросает RangeError вместо
      // молчаливой выдачи bigint — рантайм-значение всегда укладывается в
      // `SqlRow`, поэтому сужение приведением, а не проверкой на каждой
      // строке.
      db.prepare(sql).all(...params) as readonly SqlRow[],
    transaction: (body) => {
      db.exec("BEGIN");
      try {
        body();
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    [Symbol.dispose]: () => db.close(),
  };
}
