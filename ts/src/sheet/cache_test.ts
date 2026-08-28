/**
 * Кэш листов, настройки и источники диапазонов
 * (`platform/webapp-http.md`): TTL, вытеснение и слои конфигурации.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { type CacheDb, NotFoundIoError, UsageError } from "../command/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import {
  housekeeping,
  infoKey,
  invalidateTabs,
  readInfo,
  readTab,
  writeInfo,
  writeTab,
} from "./cache.ts";
import { setConfigValue, unsetConfigValue } from "../config/mod.ts";
import { cacheSettings } from "./settings.ts";
import { cacheSources, rangeStrings } from "./sources.ts";

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

async function withDb(body: (db: CacheDb) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    await body(db);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("кэш листа: запись, чтение и протухание", async (t) => {
  await withDb(async (db) => {
    await writeTab(db, "ss-1", "Sheet1", PAYLOAD, 1000);

    await t.step("живая запись читается", async () => {
      assertEquals(
        await readTab(db, "ss-1", "Sheet1", SETTINGS, 1000),
        PAYLOAD,
      );
    });

    await t.step("протухшая равнозначна отсутствующей", async () => {
      // TTL проверяется на чтении, поэтому смена настройки действует и
      // на уже лежащие записи (атом).
      assertEquals(
        await readTab(db, "ss-1", "Sheet1", SETTINGS, 1000 + 7201),
        undefined,
      );
    });

    await t.step("чужой лист не подставляется", async () => {
      assertEquals(
        await readTab(db, "ss-1", "Другой", SETTINGS, 1000),
        undefined,
      );
    });

    await t.step("повторная запись перетирает по ключу", async () => {
      const updated = { ...PAYLOAD, values: [["иное", 1]] };
      await writeTab(db, "ss-1", "Sheet1", updated, 1100);
      assertEquals(
        await readTab(db, "ss-1", "Sheet1", SETTINGS, 1100),
        updated,
      );
      assertEquals(db.query("SELECT COUNT(*) AS n FROM sheet_tabs")[0].n, 1);
    });
  });
});

Deno.test("кэш метаданных: свой TTL и ключ на таблицу", async (t) => {
  await withDb(async (db) => {
    const tabs = [{
      title: "Sheet1",
      sheet_id: 0,
      rows: 1000,
      cols: 26,
      index: 0,
    }];
    writeInfo(db, "ss-1", tabs, 1000);

    await t.step("живая запись читается", () => {
      assertEquals(readInfo(db, "ss-1", 1000), tabs);
    });

    await t.step("после 7200 секунд — промах", () => {
      assertEquals(readInfo(db, "ss-1", 1000 + 7201), undefined);
    });
  });
});

Deno.test("housekeeping: протухшие и лишние по объёму", async (t) => {
  await withDb(async (db) => {
    await writeTab(db, "ss-1", "Старый", PAYLOAD, 1000);
    await writeTab(db, "ss-1", "Свежий", PAYLOAD, 9000);

    await t.step("протухшие удаляются", async () => {
      housekeeping(db, SETTINGS, 9000);
      assertEquals(
        await readTab(db, "ss-1", "Старый", SETTINGS, 9000),
        undefined,
      );
      assertEquals(
        await readTab(db, "ss-1", "Свежий", SETTINGS, 9000) !== undefined,
        true,
      );
    });

    await t.step("при превышении объёма уходят старейшие", async () => {
      await writeTab(db, "ss-1", "Первый", PAYLOAD, 9001);
      await writeTab(db, "ss-1", "Второй", PAYLOAD, 9002);
      // Предел в ноль мегабайт: под него не влезает ни одна запись, и
      // удаление идёт от старейшей.
      housekeeping(db, { ...SETTINGS, maxTotalMb: 0 }, 9002);
      assertEquals(db.query("SELECT COUNT(*) AS n FROM sheet_tabs")[0].n, 0);
    });
  });
});

Deno.test("housekeeping на БД без таблиц не падает", () => {
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

Deno.test("настройки кэша: только предпочтения, мусор — заметкой", async (t) => {
  await withDb(async (db) => {
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

    await t.step("умолчания без источников", () => {
      assertEquals(cacheSettings(io({}, []), db), SETTINGS);
    });

    await t.step("предпочтения перекрывают умолчание", () => {
      const settings = cacheSettings(
        io({ "sheet.cache.tab_ttl": "60" }, []),
        db,
      );
      assertEquals(settings.tabTtlSeconds, 60);
    });

    await t.step("переменные окружения не читаются вовсе", () => {
      // Решение пользователя: «только явно через параметры». Ключ
      // MPU_SHEET_CACHE_* не должен влиять ни на что.
      unsetConfigValue(db, "sheet.cache.tab_ttl");
      const settings = cacheSettings(
        io({}, [], { MPU_SHEET_CACHE_TAB_TTL: "30" }),
        db,
      );
      assertEquals(settings.tabTtlSeconds, SETTINGS.tabTtlSeconds);
    });

    await t.step("нечисловое значение: заметка и умолчание", () => {
      const notes: string[] = [];
      const settings = cacheSettings(
        io({ "sheet.cache.tab_ttl": "abc" }, notes),
        db,
      );
      // Команда продолжает работу, а заметка уходит в журнал вызовов, не
      // на экран (атом, «Конфигурация»).
      assertEquals(settings.tabTtlSeconds, SETTINGS.tabTtlSeconds);
      assertEquals(notes.length, 1);
      assertEquals(notes[0].includes("sheet.cache.tab_ttl"), true);
    });
  });
});

Deno.test("источники резолва читают кэш-БД", async (t) => {
  await withDb(async (db) => {
    db.execute(
      "INSERT INTO sheet_aliases (name, ss_id, created_at) VALUES (?, ?, ?)",
      "отчёт",
      "ss-alias",
      1000,
    );
    for (
      const [ssId, clientId, title, active] of [
        ["ss-1", 4326, "Отчёт WB", 1],
        ["ss-2", 4326, "Отчёт Ozon", 1],
        ["ss-3", 777, "Архив", 0],
      ] as const
    ) {
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
    const sources = cacheSources(db);

    await t.step("алиас по точному имени", () => {
      assertEquals(sources.aliasOf("отчёт"), "ss-alias");
      assertEquals(sources.aliasOf("нет"), undefined);
    });

    await t.step("client_id даёт только активные", () => {
      assertEquals(sources.byClientId(4326).length, 2);
      assertEquals(sources.byClientId(777), []);
    });

    await t.step("подстрока заголовка без учёта регистра", () => {
      assertEquals(sources.byTitle("отчёт").length, 2);
      assertEquals(sources.byTitle("ОЗОН"), []);
      assertEquals(sources.byTitle("ozon").length, 1);
    });
  });
});

Deno.test("источники на БД без таблиц отвечают пустотой", () => {
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
  assertEquals(sources.aliasOf("отчёт"), undefined);
  assertEquals(sources.byClientId(1), []);
  assertEquals(sources.byTitle("что-то"), []);
});

Deno.test("диапазоны из --from складываются с аргументами", async (t) => {
  const io = (text: string) =>
    makeFakeIo({
      readTextFile: (path: string) => {
        if (path === "/список.txt") return Promise.resolve(text);
        throw new NotFoundIoError(`нет файла ${path}`);
      },
      readStdin: () => Promise.resolve(new TextEncoder().encode(text)),
    });

  await t.step("файл построчно, комментарии и пустые — мимо", async () => {
    const ranges = await rangeStrings(
      io("# заголовок\n\nSheet1!A1\n  Sheet1!B2  \n"),
      ["Sheet1!C3"],
      "/список.txt",
    );
    assertEquals(ranges, ["Sheet1!C3", "Sheet1!A1", "Sheet1!B2"]);
  });

  await t.step("'-' означает весь stdin", async () => {
    assertEquals(await rangeStrings(io("Sheet1!A1\n"), [], "-"), [
      "Sheet1!A1",
    ]);
  });

  await t.step("без --from берутся только аргументы", async () => {
    assertEquals(await rangeStrings(io(""), ["Sheet1!A1"], undefined), [
      "Sheet1!A1",
    ]);
  });

  await t.step("несуществующий файл — ошибка ввода", async () => {
    await assertRejects(
      () => rangeStrings(io(""), [], "/нет"),
      UsageError,
      "файл '/нет' не найден",
    );
  });
});

Deno.test("удаление ключа метаданных — одно место на репозиторий", async (t) => {
  await t.step("точечная инвалидация ходит через него же", async () => {
    // Единственность проверяется не глазами: обе команды обязаны
    // снимать ключ одним и тем же путём, иначе у одного действия
    // окажется две правды (`sheet-cache.md`, инвариант 3).
    const dir = await Deno.makeTempDir();
    try {
      using db = openCacheDb(`${dir}/mpu.db`);
      db.bootstrap();
      db.execute(
        "INSERT INTO cache (key, value, created_at, expires_at)" +
          " VALUES (?, '[]', 0, 9999999999)",
        infoKey("ss-1"),
      );
      invalidateTabs(db, "ss-1", ["Лист1"]);
      assertEquals(
        db.query("SELECT key FROM cache WHERE key = ?", infoKey("ss-1")).length,
        0,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  await t.step("в исходниках нет второго удаления ключа", async () => {
    // Проверка по тексту, а не по поведению: второе место просто
    // невозможно заметить поведением — оно удаляло бы то же самое.
    // Обход всего `src`, а не одного каталога: второе место тем и
    // опасно, что заводится не рядом.
    const root = new URL("../", import.meta.url);
    const hits: string[] = [];
    const walk = async (dir: URL): Promise<void> => {
      for await (const entry of Deno.readDir(dir)) {
        const child = new URL(
          `${entry.name}${entry.isDirectory ? "/" : ""}`,
          dir,
        );
        if (entry.isDirectory) {
          await walk(child);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith("_test.ts")) {
          continue;
        }
        const text = await Deno.readTextFile(child);
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
    assertEquals(hits.length, 2, `удаление из cache вне dropInfo: ${hits}`);
    assertEquals(
      // Путь, а не имя: второй файл, названный `cache.ts`, прошёл бы
      // проверку по имени незамеченным.
      hits.every((hit) => hit.startsWith("sheet/cache.ts:")),
      true,
      `${hits}`,
    );
  });
});
