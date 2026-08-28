/**
 * Команды-хозяева кэша вкладок (`docs/specs/sheet-cache.md`): состояние
 * и очистка.
 *
 * Кэш-БД настоящая, во временном каталоге: проверяется след — что
 * именно изменилось в `sheet_tabs` и в ключе `sheet:info:<ss_id>`, — а
 * не код возврата.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { type CacheDb, UsageError } from "../command/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { infoKey, writeTab } from "./cache.ts";
import { sheetCacheClearCommand, sheetCacheInfoCommand } from "./cmd_cache.ts";

const SS = "1SyntheticSpreadsheetIdForGoldens0000000000";
const OTHER = "1Другая0000000000000000000000000000000000";

/** Кэш-БД во временном каталоге; таблицы созданы bootstrap'ом. */
async function withDb(
  body: (db: CacheDb) => Promise<void>,
  bootstrap = true,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    if (bootstrap) db.bootstrap();
    await body(db);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const ioOf = (db: CacheDb) =>
  makeFakeIo({ openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }) });

/** Одна вкладка в кэше заданного размера. */
async function tab(db: CacheDb, ssId: string, name: string, rows: number) {
  await writeTab(db, ssId, name, {
    values: [Array.from({ length: rows }, (_, at) => `значение ${at}`)],
    formulas: [[""]],
    dims: { rows, cols: 1 },
  }, 1_700_000_000);
}

/** Строка метаданных, какую кладёт чтение листов. */
function info(db: CacheDb, ssId: string) {
  db.execute(
    "INSERT INTO cache (key, value, created_at, expires_at)" +
      " VALUES (?, ?, ?, ?)",
    infoKey(ssId),
    "[]",
    1_700_000_000,
    1_900_000_000,
  );
}

const tabsOf = (db: CacheDb, ssId: string) =>
  db.query("SELECT tab_name FROM sheet_tabs WHERE ss_id = ?", ssId).length;
const infosOf = (db: CacheDb) =>
  db.query("SELECT key FROM cache WHERE key LIKE 'sheet:info:%'").length;

Deno.test("clear: три исхода различимы строкой", async (t) => {
  await t.step("чистить было нечего", async () => {
    await withDb(async (db) => {
      const result = await sheetCacheClearCommand.invoke([], ioOf(db));
      assertEquals(
        sheetCacheClearCommand.renderResult(result, []),
        "cleared 0 tabs (весь кэш); no metadata\n",
      );
    });
  });

  await t.step("удалены вкладки", async () => {
    await withDb(async (db) => {
      await tab(db, SS, "Лист1", 3);
      await tab(db, SS, "Лист2", 3);
      info(db, SS);
      const result = await sheetCacheClearCommand.invoke([], ioOf(db));
      assertEquals(
        sheetCacheClearCommand.renderResult(result, []),
        "cleared 2 tabs (весь кэш); metadata dropped: 1\n",
      );
      assertEquals(tabsOf(db, SS), 0);
      assertEquals(infosOf(db), 0);
    });
  });

  await t.step("вкладок не было, но метаданные сброшены", async () => {
    await withDb(async (db) => {
      // Ровно случай, ради которого число вкладок и не годится одно:
      // ноль вкладок, а работа сделана. Идёт по `-s`, как в приёмке
      // спеки: там этот случай готовится вызовом `open`.
      info(db, SS);
      const argv = ["-s", SS];
      const result = await sheetCacheClearCommand.invoke(argv, ioOf(db));
      assertEquals(
        sheetCacheClearCommand.renderResult(result, argv),
        `cleared 0 tabs (${SS}); metadata dropped: 1\n`,
      );
      assertEquals(infosOf(db), 0);
    });
  });
});

Deno.test("clear -s чистит одну таблицу, соседнюю не трогает", async () => {
  await withDb(async (db) => {
    await tab(db, SS, "Лист1", 3);
    await tab(db, OTHER, "Лист1", 3);
    info(db, SS);
    info(db, OTHER);
    const argv = ["-s", SS];
    const result = await sheetCacheClearCommand.invoke(argv, ioOf(db));
    assertEquals(
      sheetCacheClearCommand.renderResult(result, argv),
      `cleared 1 tabs (${SS}); metadata dropped: 1\n`,
    );
    assertEquals(tabsOf(db, SS), 0);
    assertEquals(tabsOf(db, OTHER), 1);
    assertEquals(infosOf(db), 1);
  });
});

Deno.test("clear -s дважды подряд: второй прогон сообщает другое", async () => {
  // Приёмка спеки идёт по `-s`-пути, и ветка удаления там другая:
  // `key = ?` против `LIKE` у глобальной очистки.
  await withDb(async (db) => {
    await tab(db, SS, "Лист1", 3);
    info(db, SS);
    const argv = ["-s", SS];
    const first = await sheetCacheClearCommand.invoke(argv, ioOf(db));
    const second = await sheetCacheClearCommand.invoke(argv, ioOf(db));
    assertEquals(
      sheetCacheClearCommand.renderResult(first, argv),
      `cleared 1 tabs (${SS}); metadata dropped: 1\n`,
    );
    // Повторный прогон не повторяет первый: чистить уже нечего.
    assertEquals(
      sheetCacheClearCommand.renderResult(second, argv),
      `cleared 0 tabs (${SS}); no metadata\n`,
    );
  });
});

Deno.test("info: итог, разбивка по убыванию размера и пустой кэш", async (t) => {
  await t.step("разбивка от крупных к мелким", async () => {
    await withDb(async (db) => {
      await tab(db, SS, "Лист1", 200);
      await tab(db, OTHER, "Лист1", 3);
      const result = await sheetCacheInfoCommand.invoke([], ioOf(db));
      const text = sheetCacheInfoCommand.renderResult(result, []);
      assertStringIncludes(text, "total: 2 tabs");
      const lines = text.split("\n").filter((line) => line.startsWith("  "));
      assertEquals(lines.length, 2);
      assertStringIncludes(lines[0], SS);
      assertStringIncludes(lines[1], OTHER);
      assertStringIncludes(lines[0], "latest=1700000000");
    });
  });

  await t.step("пустой кэш — только итог с нулями", async () => {
    await withDb(async (db) => {
      const result = await sheetCacheInfoCommand.invoke([], ioOf(db));
      assertEquals(
        sheetCacheInfoCommand.renderResult(result, []),
        "total: 0 tabs, 0 KB\n",
      );
    });
  });
});

Deno.test("info состояние не меняет", async () => {
  await withDb(async (db) => {
    await tab(db, SS, "Лист1", 5);
    info(db, SS);
    const snapshot = () => [
      ...db.query(
        "SELECT ss_id, tab_name, payload, size_bytes, fetched_at" +
          " FROM sheet_tabs ORDER BY ss_id, tab_name",
      ),
      ...db.query(
        "SELECT key, value, created_at, expires_at FROM cache" +
          " ORDER BY key",
      ),
    ];
    const before = snapshot();
    await sheetCacheInfoCommand.invoke([], ioOf(db));
    // Обе таблицы кэша те же: команда «покажи состояние», молча его
    // меняющая, сделала бы недостоверной любую следующую сверку. В том
    // числе не убирает протухшее — housekeeping здесь не зовётся.
    assertEquals(snapshot(), before);
    assertEquals(infosOf(db), 1);
  });
});

Deno.test("таблиц кэша нет — обе команды успешны и говорят об этом", async () => {
  await withDb(async (db) => {
    const cleared = await sheetCacheClearCommand.invoke([], ioOf(db));
    const shown = await sheetCacheInfoCommand.invoke([], ioOf(db));
    for (
      const text of [
        sheetCacheClearCommand.renderResult(cleared, []),
        sheetCacheInfoCommand.renderResult(shown, []),
      ]
    ) {
      assertStringIncludes(text, "кэша нет: таблицы не заведены");
      assertStringIncludes(text, "mpu init");
    }
  }, false);
});

Deno.test("цель не резолвится — код 2 и ни одного удаления", async () => {
  await withDb(async (db) => {
    await tab(db, SS, "Лист1", 3);
    const err = await assertRejects(
      () => sheetCacheClearCommand.invoke(["-s", "нет-такой"], ioOf(db)),
      UsageError,
    );
    assertStringIncludes(err.message, "нет-такой");
    // Резолв идёт до всякого удаления: неразобранная цель не стоит кэша.
    assertEquals(tabsOf(db, SS), 1);
  });
});

Deno.test("отказ базы не выдаётся за «чистить нечего»", async () => {
  await withDb(async (db) => {
    await tab(db, SS, "Лист1", 3);
    // База отвечает отказом, не связанным с отсутствием таблицы. Ноль,
    // выданный в `catch`, был бы неотличим от «удалять было нечего», и
    // команда сообщила бы о несделанной работе как о сделанной.
    const broken = {
      ...db,
      execute: () => {
        throw new Error("database is locked");
      },
      [Symbol.dispose]: () => {},
    };
    await assertRejects(
      () =>
        sheetCacheClearCommand.invoke(
          [],
          makeFakeIo({ openCacheDb: () => broken }),
        ),
      Error,
      "database is locked",
    );
  });
});
