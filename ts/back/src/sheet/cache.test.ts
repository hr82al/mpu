/**
 * Кэш листов, настройки и источники диапазонов
 * (`platform/webapp-http.md`): TTL, вытеснение и слои конфигурации.
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CacheDb, NotFoundIoError, UsageError } from "@mpu/command";
import { openCacheDb } from "@mpu/command/store";
import { makeFakeIo } from "@mpu/command/testing";
import {
  housekeeping,
  infoKey,
  invalidateTabs,
  readInfo,
  readTab,
  writeInfo,
  writeTab,
} from "./cache.ts";
import { setConfigValue, unsetConfigValue } from "@mpu/command/config";
import { cacheSettings } from "./settings.ts";
import { cacheSources, rangeStrings } from "./sources.ts";
import type { TargetSources } from "./target.ts";

const SETTINGS = {
  tabTtlSeconds: 7200,
  maxTabBytes: 10_485_760,
  maxTotalMb: 500,
};

const PAYLOAD = {
  values: [["привет", 42]],
  formulas: [["привет", 42]],
  dims: { rows: 1, cols: 2 },
};

/**
 * Кэш-БД на весь `describe`: открыта до первого случая, закрыта и стёрта
 * после последнего; `use` получает открытую. Не открылась — закрывать
 * нечего, и `afterAll` не заслоняет причину своим отказом.
 */
function suiteDb(use: (db: CacheDb) => void): void {
  let dir: string | undefined;
  let opened: CacheDb | undefined;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mpu-"));
    opened = openCacheDb(`${dir}/mpu.db`);
    opened.bootstrap();
    use(opened);
  });
  afterAll(async () => {
    opened?.[Symbol.dispose]();
    if (dir !== undefined) await rm(dir, { recursive: true });
  });
}

describe("кэш листа: запись, чтение и протухание", () => {
  let db: CacheDb;
  suiteDb((opened) => (db = opened));
  beforeAll(async () => {
    await writeTab(db, "ss-1", "Sheet1", PAYLOAD, 1000);
  });

  it("живая запись читается", async () => {
    expect(await readTab(db, "ss-1", "Sheet1", SETTINGS, 1000)).toStrictEqual(
      PAYLOAD,
    );
  });

  it("протухшая равнозначна отсутствующей", async () => {
    // TTL проверяется на чтении, поэтому смена настройки действует и
    // на уже лежащие записи (атом).
    expect(
      await readTab(db, "ss-1", "Sheet1", SETTINGS, 1000 + 7201),
    ).toStrictEqual(undefined);
  });

  it("чужой лист не подставляется", async () => {
    expect(await readTab(db, "ss-1", "Другой", SETTINGS, 1000)).toStrictEqual(
      undefined,
    );
  });

  it("повторная запись перетирает по ключу", async () => {
    const updated = { ...PAYLOAD, values: [["иное", 1]] };
    await writeTab(db, "ss-1", "Sheet1", updated, 1100);
    expect(await readTab(db, "ss-1", "Sheet1", SETTINGS, 1100)).toStrictEqual(
      updated,
    );
    expect(db.query("SELECT COUNT(*) AS n FROM sheet_tabs")[0].n).toBe(1);
  });
});

describe("кэш метаданных: свой TTL и ключ на таблицу", () => {
  let db: CacheDb;
  suiteDb((opened) => (db = opened));
  const tabs = [
    {
      title: "Sheet1",
      sheet_id: 0,
      rows: 1000,
      cols: 26,
      index: 0,
    },
  ];
  beforeAll(() => {
    writeInfo(db, "ss-1", tabs, 1000);
  });

  it("живая запись читается", () => {
    expect(readInfo(db, "ss-1", 1000)).toStrictEqual(tabs);
  });

  it("после 7200 секунд — промах", () => {
    expect(readInfo(db, "ss-1", 1000 + 7201)).toStrictEqual(undefined);
  });
});

describe("housekeeping: протухшие и лишние по объёму", () => {
  let db: CacheDb;
  suiteDb((opened) => (db = opened));
  beforeAll(async () => {
    await writeTab(db, "ss-1", "Старый", PAYLOAD, 1000);
    await writeTab(db, "ss-1", "Свежий", PAYLOAD, 9000);
  });

  it("протухшие удаляются", async () => {
    housekeeping(db, SETTINGS, 9000);
    expect(await readTab(db, "ss-1", "Старый", SETTINGS, 9000)).toStrictEqual(
      undefined,
    );
    expect(
      (await readTab(db, "ss-1", "Свежий", SETTINGS, 9000)) !== undefined,
    ).toBe(true);
  });

  it("при превышении объёма уходят старейшие", async () => {
    await writeTab(db, "ss-1", "Первый", PAYLOAD, 9001);
    await writeTab(db, "ss-1", "Второй", PAYLOAD, 9002);
    // Предел в ноль мегабайт: под него не влезает ни одна запись, и
    // удаление идёт от старейшей.
    housekeeping(db, { ...SETTINGS, maxTotalMb: 0 }, 9002);
    expect(db.query("SELECT COUNT(*) AS n FROM sheet_tabs")[0].n).toBe(0);
  });
});

it("housekeeping на БД без таблиц не падает", () => {
  const empty = {
    path: ":memory:",
    bootstrap: () => {},
    execute: () => {
      throw new Error("no such table: sheet_tabs");
    },
    query: () => {
      throw new Error("no such table: sheet_tabs");
    },
    transaction: <T>(body: () => T) => body(),
    [Symbol.dispose]: () => {},
  };
  housekeeping(empty, SETTINGS, 1000);
});

describe("настройки кэша: только предпочтения, мусор — заметкой", () => {
  let db: CacheDb;
  suiteDb((opened) => (db = opened));
  const io = (
    config: Readonly<Record<string, string>>,
    notes: string[],
    env: Readonly<Record<string, string>> = {},
  ) => {
    for (const [key, value] of Object.entries(config)) {
      setConfigValue(db, key, value);
    }
    return makeFakeIo({
      envFile: {
        get: (name: string) => env[name],
        require: (name: string) => env[name] ?? "",
        set: () => Promise.resolve(),
        values: () => ({ ...env }),
      },
      note: (line: string) => void notes.push(line),
    });
  };

  it("умолчания без источников", () => {
    expect(cacheSettings(io({}, []), db)).toStrictEqual(SETTINGS);
  });

  it("предпочтения перекрывают умолчание", () => {
    const settings = cacheSettings(io({ "sheet.cache.tab_ttl": "60" }, []), db);
    expect(settings.tabTtlSeconds).toBe(60);
  });

  it("переменные окружения не читаются вовсе", () => {
    // Решение пользователя: «только явно через параметры». Ключ
    // MPU_SHEET_CACHE_* не должен влиять ни на что.
    unsetConfigValue(db, "sheet.cache.tab_ttl");
    const settings = cacheSettings(
      io({}, [], { MPU_SHEET_CACHE_TAB_TTL: "30" }),
      db,
    );
    expect(settings.tabTtlSeconds).toStrictEqual(SETTINGS.tabTtlSeconds);
  });

  it("нечисловое значение: заметка и умолчание", () => {
    const notes: string[] = [];
    const settings = cacheSettings(
      io({ "sheet.cache.tab_ttl": "abc" }, notes),
      db,
    );
    // Команда продолжает работу, а заметка уходит в журнал вызовов, не
    // на экран (атом, «Конфигурация»).
    expect(settings.tabTtlSeconds).toStrictEqual(SETTINGS.tabTtlSeconds);
    expect(notes.length).toBe(1);
    expect(notes[0].includes("sheet.cache.tab_ttl")).toBe(true);
  });
});

describe("источники резолва читают кэш-БД", () => {
  let sources: TargetSources;
  let db: CacheDb;
  suiteDb((opened) => (db = opened));
  beforeAll(() => {
    db.execute(
      "INSERT INTO sheet_aliases (name, ss_id, created_at) VALUES (?, ?, ?)",
      "отчёт",
      "ss-alias",
      1000,
    );
    for (const [ssId, clientId, title, active] of [
      ["ss-1", 4326, "Отчёт WB", 1],
      ["ss-2", 4326, "Отчёт Ozon", 1],
      ["ss-3", 777, "Архив", 0],
    ] as const) {
      db.execute(
        "INSERT INTO sl_spreadsheets (ss_id, client_id, title, is_active," +
          " server, synced_at) VALUES (?, ?, ?, ?, ?, ?)",
        ssId,
        clientId,
        title,
        active,
        "sl-9",
        1000,
      );
    }
    sources = cacheSources(db);
  });

  it("алиас по точному имени", () => {
    expect(sources.aliasOf("отчёт")).toBe("ss-alias");
    expect(sources.aliasOf("нет")).toStrictEqual(undefined);
  });

  it("client_id даёт только активные", () => {
    expect(sources.byClientId(4326).length).toBe(2);
    expect(sources.byClientId(777)).toStrictEqual([]);
  });

  it("подстрока заголовка без учёта регистра", () => {
    expect(sources.byTitle("отчёт").length).toBe(2);
    expect(sources.byTitle("ОЗОН")).toStrictEqual([]);
    expect(sources.byTitle("ozon").length).toBe(1);
  });
});

it("источники на БД без таблиц отвечают пустотой", () => {
  const empty = {
    path: ":memory:",
    bootstrap: () => {},
    execute: () => 0,
    query: () => {
      throw new Error("no such table: sheet_aliases");
    },
    transaction: <T>(body: () => T) => body(),
    [Symbol.dispose]: () => {},
  };
  const sources = cacheSources(empty);
  // Свежая БД без bootstrap: резолв просто ничего не находит, а не
  // роняет команду (атом, «Граничные случаи»).
  expect(sources.aliasOf("отчёт")).toStrictEqual(undefined);
  expect(sources.byClientId(1)).toStrictEqual([]);
  expect(sources.byTitle("что-то")).toStrictEqual([]);
});

describe("диапазоны из --from складываются с аргументами", () => {
  const io = (text: string) =>
    makeFakeIo({
      readTextFile: (path: string) => {
        if (path === "/список.txt") return Promise.resolve(text);
        throw new NotFoundIoError(`нет файла ${path}`);
      },
      readStdin: () => Promise.resolve(new TextEncoder().encode(text)),
    });

  it("файл построчно, комментарии и пустые — мимо", async () => {
    const ranges = await rangeStrings(
      io("# заголовок\n\nSheet1!A1\n  Sheet1!B2  \n"),
      ["Sheet1!C3"],
      "/список.txt",
    );
    expect(ranges).toStrictEqual(["Sheet1!C3", "Sheet1!A1", "Sheet1!B2"]);
  });

  it("'-' означает весь stdin", async () => {
    expect(await rangeStrings(io("Sheet1!A1\n"), [], "-")).toStrictEqual([
      "Sheet1!A1",
    ]);
  });

  it("без --from берутся только аргументы", async () => {
    expect(await rangeStrings(io(""), ["Sheet1!A1"], undefined)).toStrictEqual([
      "Sheet1!A1",
    ]);
  });

  it("несуществующий файл — ошибка ввода", async () => {
    const failure = rangeStrings(io(""), [], "/нет");
    await expect(failure).rejects.toThrow(UsageError);
    await expect(failure).rejects.toThrow("файл '/нет' не найден");
  });
});

describe("удаление ключа метаданных — одно место на репозиторий", () => {
  it("точечная инвалидация ходит через него же", async () => {
    // Единственность проверяется не глазами: обе команды обязаны
    // снимать ключ одним и тем же путём, иначе у одного действия
    // окажется две правды (`sheet-cache.md`, инвариант 3).
    const dir = await mkdtemp(join(tmpdir(), "mpu-"));
    try {
      using db = openCacheDb(`${dir}/mpu.db`);
      db.bootstrap();
      db.execute(
        "INSERT INTO cache (key, value, created_at, expires_at)" +
          " VALUES (?, '[]', 0, 9999999999)",
        infoKey("ss-1"),
      );
      invalidateTabs(db, "ss-1", ["Лист1"]);
      expect(
        db.query("SELECT key FROM cache WHERE key = ?", infoKey("ss-1")).length,
      ).toBe(0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("в исходниках нет второго удаления ключа", async () => {
    // Проверка по тексту, а не по поведению: второе место просто
    // невозможно заметить поведением — оно удаляло бы то же самое.
    // Обход всего `src`, а не одного каталога: второе место тем и
    // опасно, что заводится не рядом.
    const root = new URL("../", import.meta.url);
    const hits: string[] = [];
    const walk = async (dir: URL): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const child = new URL(
          `${entry.name}${entry.isDirectory() ? "/" : ""}`,
          dir,
        );
        if (entry.isDirectory()) {
          await walk(child);
          continue;
        }
        // Тесты — обоих раннеров: `*_test.ts` (deno test) и `*.test.ts`
        // (Vitest).
        if (
          !entry.name.endsWith(".ts") ||
          entry.name.endsWith("_test.ts") ||
          entry.name.endsWith(".test.ts")
        )
          continue;
        const text = await readFile(child, "utf8");
        for (const line of text.split("\n")) {
          if (/DELETE\s+FROM\s+cache\b/i.test(line)) {
            hits.push(
              `${child.pathname.slice(root.pathname.length)}: ${line.trim()}`,
            );
          }
        }
      }
    };
    await walk(root);
    // Обе строки — в `dropInfo`: по ключу и по образцу `sheet:info:%`.
    expect(hits.length, `удаление из cache вне dropInfo: ${hits}`).toBe(2);
    expect(
      hits.every((hit) => hit.startsWith("sheet/cache.ts:")),
      `${hits}`,
    ).toBe(true);
  });
});
