/**
 * Команды-хозяева кэша вкладок (`docs/specs/sheet-cache.md`): состояние
 * и очистка.
 *
 * Кэш-БД настоящая, во временном каталоге: проверяется след — что
 * именно изменилось в `sheet_tabs` и в ключе `sheet:info:<ss_id>`, — а
 * не код возврата.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rejected } from "../testing/thrown.ts";
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
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    if (bootstrap) db.bootstrap();
    await body(db);
  } finally {
    await rm(dir, { recursive: true });
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

describe("clear: три исхода различимы строкой", () => {
  it("чистить было нечего", async () => {
    await withDb(async (db) => {
      const result = await sheetCacheClearCommand.invoke([], ioOf(db));
      expect(sheetCacheClearCommand.renderResult(result, [])).toBe(
        "cleared 0 tabs (весь кэш); no metadata\n",
      );
    });
  });

  it("удалены вкладки", async () => {
    await withDb(async (db) => {
      await tab(db, SS, "Лист1", 3);
      await tab(db, SS, "Лист2", 3);
      info(db, SS);
      const result = await sheetCacheClearCommand.invoke([], ioOf(db));
      expect(sheetCacheClearCommand.renderResult(result, [])).toBe(
        "cleared 2 tabs (весь кэш); metadata dropped: 1\n",
      );
      expect(tabsOf(db, SS)).toBe(0);
      expect(infosOf(db)).toBe(0);
    });
  });

  it("вкладок не было, но метаданные сброшены", async () => {
    await withDb(async (db) => {
      // Ровно случай, ради которого число вкладок и не годится одно:
      // ноль вкладок, а работа сделана. Идёт по `-s`, как в приёмке
      // спеки: там этот случай готовится вызовом `open`.
      info(db, SS);
      const argv = ["-s", SS];
      const result = await sheetCacheClearCommand.invoke(argv, ioOf(db));
      expect(sheetCacheClearCommand.renderResult(result, argv)).toStrictEqual(
        `cleared 0 tabs (${SS}); metadata dropped: 1\n`,
      );
      expect(infosOf(db)).toBe(0);
    });
  });
});

it("clear -s чистит одну таблицу, соседнюю не трогает", async () => {
  await withDb(async (db) => {
    await tab(db, SS, "Лист1", 3);
    await tab(db, OTHER, "Лист1", 3);
    info(db, SS);
    info(db, OTHER);
    const argv = ["-s", SS];
    const result = await sheetCacheClearCommand.invoke(argv, ioOf(db));
    expect(sheetCacheClearCommand.renderResult(result, argv)).toStrictEqual(
      `cleared 1 tabs (${SS}); metadata dropped: 1\n`,
    );
    expect(tabsOf(db, SS)).toBe(0);
    expect(tabsOf(db, OTHER)).toBe(1);
    expect(infosOf(db)).toBe(1);
  });
});

it("clear -s дважды подряд: второй прогон сообщает другое", async () => {
  // Приёмка спеки идёт по `-s`-пути, и ветка удаления там другая:
  // `key = ?` против `LIKE` у глобальной очистки.
  await withDb(async (db) => {
    await tab(db, SS, "Лист1", 3);
    info(db, SS);
    const argv = ["-s", SS];
    const first = await sheetCacheClearCommand.invoke(argv, ioOf(db));
    const second = await sheetCacheClearCommand.invoke(argv, ioOf(db));
    expect(sheetCacheClearCommand.renderResult(first, argv)).toStrictEqual(
      `cleared 1 tabs (${SS}); metadata dropped: 1\n`,
    );
    // Повторный прогон не повторяет первый: чистить уже нечего.
    expect(sheetCacheClearCommand.renderResult(second, argv)).toStrictEqual(
      `cleared 0 tabs (${SS}); no metadata\n`,
    );
  });
});

describe("info: итог, разбивка по убыванию размера и пустой кэш", () => {
  it("разбивка от крупных к мелким", async () => {
    await withDb(async (db) => {
      await tab(db, SS, "Лист1", 200);
      await tab(db, OTHER, "Лист1", 3);
      const result = await sheetCacheInfoCommand.invoke([], ioOf(db));
      const text = sheetCacheInfoCommand.renderResult(result, []);
      expect(text).toContain("total: 2 tabs");
      const lines = text.split("\n").filter((line) => line.startsWith("  "));
      expect(lines.length).toBe(2);
      expect(lines[0]).toContain(SS);
      expect(lines[1]).toContain(OTHER);
      expect(lines[0]).toContain("latest=1700000000");
    });
  });

  it("пустой кэш — только итог с нулями", async () => {
    await withDb(async (db) => {
      const result = await sheetCacheInfoCommand.invoke([], ioOf(db));
      expect(sheetCacheInfoCommand.renderResult(result, [])).toBe(
        "total: 0 tabs, 0 KB\n",
      );
    });
  });
});

it("info состояние не меняет", async () => {
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
    expect(snapshot()).toStrictEqual(before);
    expect(infosOf(db)).toBe(1);
  });
});

it("таблиц кэша нет — обе команды успешны и говорят об этом", async () => {
  await withDb(async (db) => {
    const cleared = await sheetCacheClearCommand.invoke([], ioOf(db));
    const shown = await sheetCacheInfoCommand.invoke([], ioOf(db));
    for (
      const text of [
        sheetCacheClearCommand.renderResult(cleared, []),
        sheetCacheInfoCommand.renderResult(shown, []),
      ]
    ) {
      expect(text).toContain("кэша нет: таблицы не заведены");
      expect(text).toContain("mpu init");
    }
  }, false);
});

it("цель не резолвится — код 2 и ни одного удаления", async () => {
  await withDb(async (db) => {
    await tab(db, SS, "Лист1", 3);
    const err = await rejected(() =>
      sheetCacheClearCommand.invoke(
        ["-s", "нет-такой"],
        ioOf(db),
      ), UsageError);
    expect(err.message).toContain("нет-такой");
    // Резолв идёт до всякого удаления: неразобранная цель не стоит кэша.
    expect(tabsOf(db, SS)).toBe(1);
  });
});

it("отказ базы не выдаётся за «чистить нечего»", async () => {
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
    const failure = sheetCacheClearCommand.invoke(
      [],
      makeFakeIo({ openCacheDb: () => broken }),
    );
    await expect(failure).rejects.toThrow(Error);
    await expect(failure).rejects.toThrow("database is locked");
  });
});
