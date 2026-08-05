/**
 * Тесты атома кэш-БД (`docs/specs/platform/store.md`): открытие,
 * идемпотентный bootstrap, self-heal частично отсутствующей схемы,
 * транзакции с откатом. Эталон схемы — копия фикстуры `testdata/schema.sql`
 * (её совпадение с каналом стережёт `fixtures_test.ts`), а не отдельно
 * вписанный список DDL: расхождение со схемой ловится здесь, расхождение
 * копии с каналом — там.
 */

import { assertEquals, assertThrows } from "@std/assert";
import type { CacheDb, SqlRow } from "../command/mod.ts";
import { openCacheDb } from "./mod.ts";

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
  const fixture = await Deno.readTextFile(
    new URL("testdata/schema.sql", import.meta.url),
  );
  return fixture
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n")
    .replace(/^\n+/, "");
}

Deno.test("bootstrap: sqlite_master чистой БД совпадает с фикстурой", async () => {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    assertEquals(dumpSchema(db), await readExpectedDump());
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("openCacheDb создаёт недостающий каталог файла", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/nested/sub/mpu.db`;
    using db = openCacheDb(path);
    assertEquals(db.path, path);
    db.bootstrap();
    assertEquals((await Deno.stat(path)).isFile, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("повторный bootstrap на БД с данными данные не теряет", async () => {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    db.execute(
      "INSERT INTO config (key, value) VALUES (?, ?)",
      "greeting",
      "привет",
    );
    db.bootstrap();
    assertEquals(db.query("SELECT key, value FROM config"), [
      { key: "greeting", value: "привет" },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("БД без части таблиц: bootstrap досоздаёт недостающие", async () => {
  const dir = await Deno.makeTempDir();
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
      assertEquals(db.query("SELECT key, value FROM config"), [
        { key: "k", value: "v" },
      ]);
      // Недостающая таблица и её индекс появились.
      assertEquals(
        db.query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'xlsx_aliases'",
        ).length,
        1,
      );
      assertEquals(
        db.query(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_cache_expires_at'",
        ).length,
        1,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("execute возвращает число изменённых строк", async () => {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    assertEquals(
      db.execute("INSERT INTO config (key, value) VALUES (?, ?)", "a", "1"),
      1,
    );
    assertEquals(
      db.execute("UPDATE config SET value = ? WHERE key = ?", "2", "a"),
      1,
    );
    assertEquals(
      db.execute(
        "UPDATE config SET value = ? WHERE key = ?",
        "3",
        "нет-такого-ключа",
      ),
      0,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("query возвращает пустой массив и понимает NULL-параметр", async () => {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    assertEquals(db.query("SELECT key FROM config"), []);
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
    assertEquals(
      db.query("SELECT endpoint_name FROM portainer_containers"),
      [{ endpoint_name: null }],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("успешная transaction фиксирует запись", async () => {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    db.transaction(() => {
      db.execute("INSERT INTO config (key, value) VALUES (?, ?)", "k", "v");
    });
    assertEquals(db.query("SELECT key, value FROM config"), [
      { key: "k", value: "v" },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("исключение внутри transaction откатывает запись и пробрасывает исходную ошибку", async () => {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    assertThrows(
      () =>
        db.transaction(() => {
          db.execute("INSERT INTO config (key, value) VALUES (?, ?)", "k", "v");
          throw new BoomError("boom");
        }),
      BoomError,
      "boom",
    );
    assertEquals(db.query("SELECT key FROM config"), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("[Symbol.dispose] закрывает БД", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/mpu.db`;
    const db = openCacheDb(path);
    db.bootstrap();
    db[Symbol.dispose]();
    assertThrows(() => db.query("SELECT 1"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ошибки SQLite пробрасываются как есть", async () => {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    assertThrows(() => db.execute("НЕ SQL СОВСЕМ"), Error);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("чтение без предшествующего bootstrap падает ошибкой отсутствующей таблицы", async () => {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    assertThrows(
      () => db.query("SELECT key FROM config"),
      Error,
      "no such table: config",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("повреждённый файл БД: ошибка SQLite пробрасывается, атом не лечит файл", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/mpu.db`;
    await Deno.writeTextFile(path, "мусор, а не файл SQLite");
    assertThrows(
      () => openCacheDb(path),
      Error,
      "file is not a database",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("openCacheDb устанавливает журнальный режим WAL", async () => {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    assertEquals(db.query("PRAGMA journal_mode"), [{ journal_mode: "wal" }]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("режим WAL персистентен между открытиями", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/mpu.db`;
    {
      using seed = openCacheDb(path);
      seed.bootstrap();
    }
    using db = openCacheDb(path);
    assertEquals(db.query("PRAGMA journal_mode"), [{ journal_mode: "wal" }]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// mode на POSIX всегда есть; тесты не для Windows.
Deno.test("bootstrap приводит права файла БД к 0600", async (t) => {
  await t.step("только что созданный файл", async () => {
    const dir = await Deno.makeTempDir();
    try {
      const path = `${dir}/mpu.db`;
      using db = openCacheDb(path);
      db.bootstrap();
      assertEquals(Deno.statSync(path).mode! & 0o777, 0o600);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  await t.step("существующий файл с широкими правами", async () => {
    const dir = await Deno.makeTempDir();
    try {
      const path = `${dir}/mpu.db`;
      Deno.writeTextFileSync(path, "");
      Deno.chmodSync(path, 0o644);
      using db = openCacheDb(path);
      db.bootstrap();
      assertEquals(Deno.statSync(path).mode! & 0o777, 0o600);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});

// mode на POSIX всегда есть; тесты не для Windows.
Deno.test("чтение прав файла БД не меняет", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/mpu.db`;
    {
      using seed = openCacheDb(path);
      seed.bootstrap();
    }
    Deno.chmodSync(path, 0o644);
    using db = openCacheDb(path);
    db.query("SELECT key FROM config");
    assertEquals(Deno.statSync(path).mode! & 0o777, 0o644);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
