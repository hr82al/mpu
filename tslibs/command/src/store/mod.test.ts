/**
 * Тесты атома кэш-БД (`docs/specs/platform/store.md`): открытие,
 * идемпотентный bootstrap, self-heal частично отсутствующей схемы,
 * транзакции с откатом. Эталон схемы — копия фикстуры `testdata/schema.sql`
 * (как она меняется — `CLAUDE.md` пакета, «Раскладка»), а не отдельно
 * вписанный список DDL: расхождение со схемой ловится здесь.
 */

import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { plainRows } from "../testing/cache.ts";
import { thrown } from "@mpu/testing/thrown";
import type { CacheDb, SqlRow } from "../command/mod.ts";
import { BUSY_TIMEOUT_MS, openCacheDb } from "./mod.ts";

/** Ошибка с именем — чтобы transaction-тест различал её не по тексту. */
class BoomError extends Error {
  override name = "BoomError";
}

/**
 * Дамп `sqlite_master` в формате эталона (см. заголовок `testdata/schema.sql`
 * и проект реализации порции А, раздел «Слой store»): `sql + ";"` по
 * объектам, склеенным через пустую строку, с завершающим `\n`.
 */
function dumpSchema(db: CacheDb): string {
  const rows = db.query(
    "SELECT type, name, sql FROM sqlite_master " +
      "WHERE sql IS NOT NULL ORDER BY type = 'index', name",
  );
  // biome-ignore lint/style/useTemplate: склейка читается лучше шаблона с вложенным шаблоном
  return rows.map((row) => `${textColumn(row.sql)};`).join("\n\n") + "\n";
}

function textColumn(value: SqlRow[string]): string {
  if (typeof value !== "string") {
    throw new TypeError(
      `sqlite_master.sql: ожидалась строка, пришло ${typeof value}`,
    );
  }
  return value;
}

/**
 * Эталон дампа: копия фикстуры без шапки-комментария (снята живым
 * bootstrap Python-версии). Шапка отбрасывается по признаку строки, а не
 * по их числу: вырастет комментарий в канале — тест продолжит сверять
 * ровно тот же DDL, а не упадёт с непонятным расхождением.
 */
async function readExpectedDump(): Promise<string> {
  const fixture = await readFile(
    new URL("testdata/schema.sql", import.meta.url),
    "utf8",
  );
  return fixture
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n")
    .replace(/^\n+/, "");
}

it("bootstrap: sqlite_master чистой БД совпадает с фикстурой", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    expect(dumpSchema(db)).toStrictEqual(await readExpectedDump());
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("занятая база ждёт, а не отказывает: busy_timeout выставлен", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    // К одному файлу ходят соседние процессы `mpu` и одновременные
    // строки сервера (`platform/line-concurrency.md`); ждать их — дело
    // самой SQLite, и значение ожидания задаётся при открытии.
    expect(plainRows(db.query("PRAGMA busy_timeout"))[0]).toStrictEqual({
      timeout: BUSY_TIMEOUT_MS,
    });
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("openCacheDb создаёт недостающий каталог файла", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const path = `${dir}/nested/sub/mpu.db`;
    using db = openCacheDb(path);
    expect(db.path).toStrictEqual(path);
    db.bootstrap();
    expect((await stat(path)).isFile()).toBe(true);
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("повторный bootstrap на БД с данными данные не теряет", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    db.execute(
      "INSERT INTO config (key, value) VALUES (?, ?)",
      "greeting",
      "привет",
    );
    db.bootstrap();
    expect(plainRows(db.query("SELECT key, value FROM config"))).toStrictEqual([
      { key: "greeting", value: "привет" },
    ]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("БД без части таблиц: bootstrap досоздаёт недостающие", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  const path = `${dir}/mpu.db`;
  try {
    {
      using seed = openCacheDb(path);
      // Ручное создание одной таблицы схемы — без остальных 23 и без
      // единого индекса: имитирует БД старой версии (`platform/store.md`,
      // «self-heal»).
      seed.execute(
        "CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      seed.execute("INSERT INTO config (key, value) VALUES (?, ?)", "k", "v");
    }
    {
      using db = openCacheDb(path);
      db.bootstrap();
      // Старые данные целы.
      expect(
        plainRows(db.query("SELECT key, value FROM config")),
      ).toStrictEqual([{ key: "k", value: "v" }]);
      // Недостающая таблица и её индекс появились.
      expect(
        db.query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'xlsx_aliases'",
        ).length,
      ).toBe(1);
      expect(
        db.query(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_cache_expires_at'",
        ).length,
      ).toBe(1);
    }
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("execute возвращает число изменённых строк", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    expect(
      db.execute("INSERT INTO config (key, value) VALUES (?, ?)", "a", "1"),
    ).toBe(1);
    expect(
      db.execute("UPDATE config SET value = ? WHERE key = ?", "2", "a"),
    ).toBe(1);
    expect(
      db.execute(
        "UPDATE config SET value = ? WHERE key = ?",
        "3",
        "нет-такого-ключа",
      ),
    ).toBe(0);
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("query возвращает пустой массив и понимает NULL-параметр", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    expect(plainRows(db.query("SELECT key FROM config"))).toStrictEqual([]);
    db.execute(
      "INSERT INTO portainer_containers (portainer_url, endpoint_id, endpoint_name, container_id, container_name, server_number, state, image, discovered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      "http://portainer",
      1,
      null,
      "abc",
      "sl-1-cli",
      1,
      "running",
      "img",
      1000,
    );
    expect(
      plainRows(db.query("SELECT endpoint_name FROM portainer_containers")),
    ).toStrictEqual([{ endpoint_name: null }]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("успешная transaction фиксирует запись", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    db.transaction(() => {
      db.execute("INSERT INTO config (key, value) VALUES (?, ?)", "k", "v");
    });
    expect(plainRows(db.query("SELECT key, value FROM config"))).toStrictEqual([
      { key: "k", value: "v" },
    ]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("исключение внутри transaction откатывает запись и пробрасывает исходную ошибку", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    thrown(
      () =>
        db.transaction(() => {
          db.execute("INSERT INTO config (key, value) VALUES (?, ?)", "k", "v");
          throw new BoomError("boom");
        }),
      BoomError,
      "boom",
    );
    expect(plainRows(db.query("SELECT key FROM config"))).toStrictEqual([]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("[Symbol.dispose] закрывает БД", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const path = `${dir}/mpu.db`;
    const db = openCacheDb(path);
    db.bootstrap();
    db[Symbol.dispose]();
    expect(() => db.query("SELECT 1")).toThrow();
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("ошибки SQLite пробрасываются как есть", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    expect(() => db.execute("НЕ SQL СОВСЕМ")).toThrow(Error);
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("чтение без предшествующего bootstrap падает ошибкой отсутствующей таблицы", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    thrown(
      () => db.query("SELECT key FROM config"),
      Error,
      "no such table: config",
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("повреждённый файл БД: ошибка SQLite пробрасывается, атом не лечит файл", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const path = `${dir}/mpu.db`;
    await writeFile(path, "мусор, а не файл SQLite");
    thrown(() => openCacheDb(path), Error, "file is not a database");
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("openCacheDb устанавливает журнальный режим WAL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    expect(plainRows(db.query("PRAGMA journal_mode"))).toStrictEqual([
      {
        journal_mode: "wal",
      },
    ]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("режим WAL персистентен между открытиями", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const path = `${dir}/mpu.db`;
    {
      using seed = openCacheDb(path);
      seed.bootstrap();
    }
    using db = openCacheDb(path);
    expect(plainRows(db.query("PRAGMA journal_mode"))).toStrictEqual([
      {
        journal_mode: "wal",
      },
    ]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

// mode на POSIX всегда есть; тесты не для Windows.
it("openCacheDb создаёт новый файл БД сразу с правами 0600, до bootstrap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const path = `${dir}/mpu.db`;
    using db = openCacheDb(path);
    expect(db.path).toStrictEqual(path);
    // Права проверяются до любого bootstrap: окна с широкими правами нет
    // уже в момент открытия (`platform/store.md`, «Ввод/вывод»).
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally {
    await rm(dir, { recursive: true });
  }
});

// mode на POSIX всегда есть; тесты не для Windows.
it("openCacheDb пробрасывает ошибку создания файла, отличную от AlreadyExists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  const noWriteDir = `${dir}/nowrite`;
  mkdirSync(noWriteDir);
  chmodSync(noWriteDir, 0o555);
  try {
    // Каталог существует (mkdirSync внутри openCacheDb — не в чем ошибаться),
    // но без права записи создание нового файла БД падает PermissionDenied —
    // не тем исключением, что ветка "файл уже есть" глотает.
    // Отказ в доступе у Deno несёт код `EACCES`, как ошибка `node:fs`:
    // класс Deno тест не называет, код — тот же признак.
    expect(() => openCacheDb(`${noWriteDir}/mpu.db`)).toThrow(
      expect.objectContaining({ code: "EACCES" }),
    );
  } finally {
    chmodSync(noWriteDir, 0o755);
    await rm(dir, { recursive: true });
  }
});

// mode на POSIX всегда есть; тесты не для Windows.
describe("bootstrap приводит права файла БД к 0600", () => {
  it("только что созданный файл", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mpu-"));
    try {
      const path = `${dir}/mpu.db`;
      using db = openCacheDb(path);
      db.bootstrap();
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("существующий файл с широкими правами", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mpu-"));
    try {
      const path = `${dir}/mpu.db`;
      writeFileSync(path, "");
      chmodSync(path, 0o644);
      using db = openCacheDb(path);
      db.bootstrap();
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

// mode на POSIX всегда есть; тесты не для Windows.
it("служебные -wal/-shm рядом с БД получают права 0600", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const path = `${dir}/mpu.db`;
    using db = openCacheDb(path);
    // -wal/-shm появляются не при открытии и не от одной лишь
    // PRAGMA journal_mode=WAL, а только у первой настоящей записи —
    // bootstrap её и делает; проверка снята, пока соединение открыто и
    // эта запись уже была, ровно тогда, когда файлы существуют на диске.
    db.bootstrap();
    expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}-shm`).mode & 0o777).toBe(0o600);
  } finally {
    await rm(dir, { recursive: true });
  }
});

// mode на POSIX всегда есть; тесты не для Windows.
it("чтение прав файла БД не меняет", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const path = `${dir}/mpu.db`;
    {
      using seed = openCacheDb(path);
      seed.bootstrap();
    }
    chmodSync(path, 0o644);
    using db = openCacheDb(path);
    db.query("SELECT key FROM config");
    expect(statSync(path).mode & 0o777).toBe(0o644);
  } finally {
    await rm(dir, { recursive: true });
  }
});
