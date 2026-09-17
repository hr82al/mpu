/**
 * Реестр таблиц (`docs/specs/sheet-registry.md`): алиасы и `open`.
 *
 * Кэш-БД настоящая, во временном каталоге: проверяется след — строки
 * `sheet_aliases` и ключ `sheet:info:<ss_id>`, — а не код возврата.
 * Ссылка сверяется дословно: запуск открывателя отсюда недостижим, и
 * она единственное, что проверяемо здесь.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type CacheDb,
  type CommandIo,
  DomainError,
  NotFoundIoError,
  UsageError,
} from "../command/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { infoKey } from "./cache.ts";
import {
  sheetAliasAddCommand,
  sheetAliasLsCommand,
  sheetAliasRmCommand,
} from "./cmd_alias.ts";
import { runOpen, sheetOpenCommand } from "./cmd_open.ts";

const SS = "1SyntheticSpreadsheetIdForGoldens0000000000";
const OTHER = "1SecondSyntheticSpreadsheetId000000000000";
const URL_OF = "https://docs.google.com/spreadsheets/d/";

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

/** Порт для алиасов: кроме кэш-БД им ничего не нужно. */
const ioOf = (db: CacheDb) =>
  makeFakeIo({ openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }) });

/** Ответ webapp на `spreadsheets/get`: два листа с разными gid. */
function tabsReply(): { status: number; text: string } {
  return {
    status: 200,
    text: JSON.stringify({
      success: true,
      result: {
        sheets: [
          {
            properties: {
              title: "Сводка",
              sheetId: 1734567890,
              index: 0,
              gridProperties: { rowCount: 1000, columnCount: 26 },
            },
          },
          {
            properties: {
              title: "Данные",
              sheetId: 42,
              index: 1,
              gridProperties: { rowCount: 10, columnCount: 3 },
            },
          },
        ],
      },
    }),
  };
}

/**
 * Окружение `open`: кэш-БД, env-файл с адресом webapp, счётчик
 * запусков открывателя и подставной канал.
 */
function harness(
  db: CacheDb,
  overrides: Partial<CommandIo> = {},
  post: (url: string, body: string) => Promise<
    { status: number; text: string }
  > = () => Promise.resolve(tabsReply()),
) {
  const launched: string[] = [];
  const notes: string[] = [];
  const io = makeFakeIo({
    envFile: {
      get: (name: string) =>
        name === "WB_PLUS_WEB_APP_URL"
          ? "https://script.example/exec"
          : undefined,
      require: (name: string) => {
        if (name === "WB_PLUS_WEB_APP_URL") {
          return "https://script.example/exec";
        }
        throw new DomainError(`нет ключа ${name}`);
      },
      set: () => Promise.reject(new Error("запись env-файла не ожидается")),
      values: () => ({}),
    },
    openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }),
    readTextFile: (path: string) => {
      throw new NotFoundIoError(`нет файла ${path}`);
    },
    note: (line: string) => void notes.push(line),
    launchOpener: (cmd: string, target: string) => {
      launched.push(`${cmd} ${target}`);
      return true;
    },
    ...overrides,
  });
  return { io, launched, notes, options: { post, nowSeconds: 1_700_000_000 } };
}

/** Снимок обеих таблиц кэша — тот же, которым сверяется `cache info`. */
const cacheSnapshot = (db: CacheDb) => [
  ...db.query(
    "SELECT ss_id, tab_name, payload, size_bytes, fetched_at FROM sheet_tabs" +
      " ORDER BY ss_id, tab_name",
  ),
  ...db.query(
    "SELECT key, value, created_at, expires_at FROM cache ORDER BY key",
  ),
];

const aliasRowsOf = (db: CacheDb) =>
  db.query("SELECT name, ss_id FROM sheet_aliases ORDER BY name");

Deno.test("alias add поверх существующего имени обновляет строку", async () => {
  await withDb(async (db) => {
    const firstArgv = ["otchet", SS];
    const first = await sheetAliasAddCommand.invoke(firstArgv, ioOf(db));
    assertEquals(
      sheetAliasAddCommand.renderResult(first, firstArgv),
      `alias 'otchet' → ${SS}\n`,
    );
    const secondArgv = ["otchet", OTHER];
    const second = await sheetAliasAddCommand.invoke(secondArgv, ioOf(db));
    // Строк не прибавилось, идентификатор сменился — обе половины
    // требования спеки («Хранилище»), и вторая без первой ничего не
    // значит: две строки на имя тоже «сменили бы» идентификатор.
    assertEquals(aliasRowsOf(db), [{ name: "otchet", ss_id: OTHER }]);
    // Вывод называет обе стороны замены: без прежнего значения
    // оператор не увидит единственного, что мог сделать не так.
    assertEquals(
      sheetAliasAddCommand.renderResult(second, secondArgv),
      `alias 'otchet': ${SS} → ${OTHER}\n`,
    );
  });
});

Deno.test("alias add: что отвергается до записи", async (t) => {
  await t.step("недопустимое имя", async () => {
    await withDb(async (db) => {
      const err = await assertRejects(
        () => sheetAliasAddCommand.invoke(["от чёт", SS], ioOf(db)),
        UsageError,
      );
      // Отказ называет допустимый набор: иначе оператор перебирает.
      assertStringIncludes(err.message, "буквы, цифры");
      assertEquals(aliasRowsOf(db).length, 0);
    });
  });

  await t.step("ТАБЛИЦА не идентификатор и не ссылка", async () => {
    await withDb(async (db) => {
      await assertRejects(
        () => sheetAliasAddCommand.invoke(["otchet", "Отчёт за май"], ioOf(db)),
        UsageError,
      );
      assertEquals(aliasRowsOf(db).length, 0);
    });
  });

  await t.step("ссылка принимается, в реестр идёт идентификатор", async () => {
    await withDb(async (db) => {
      await sheetAliasAddCommand.invoke(
        ["otchet", `${URL_OF}${SS}/edit#gid=0`],
        ioOf(db),
      );
      assertEquals(aliasRowsOf(db), [{ name: "otchet", ss_id: SS }]);
    });
  });

  await t.step("короткий хвост ссылки идентификатором не станет", async () => {
    await withDb(async (db) => {
      await assertRejects(
        () =>
          sheetAliasAddCommand.invoke(
            ["otchet", `${URL_OF}abc/edit`],
            ioOf(db),
          ),
        UsageError,
      );
      assertEquals(aliasRowsOf(db).length, 0);
    });
  });
});

Deno.test("alias ls: по имени, пустой реестр — пустой вывод", async (t) => {
  await t.step("сортировка по имени", async () => {
    await withDb(async (db) => {
      await sheetAliasAddCommand.invoke(["vtoroj", OTHER], ioOf(db));
      await sheetAliasAddCommand.invoke(["altyj", SS], ioOf(db));
      const result = await sheetAliasLsCommand.invoke([], ioOf(db));
      assertEquals(
        sheetAliasLsCommand.renderResult(result, []),
        `altyj\t${SS}\nvtoroj\t${OTHER}\n`,
      );
    });
  });

  await t.step("пустой реестр", async () => {
    await withDb(async (db) => {
      const result = await sheetAliasLsCommand.invoke([], ioOf(db));
      assertEquals(sheetAliasLsCommand.renderResult(result, []), "");
    });
  });

  await t.step("таблицы алиасов нет вовсе — тоже пусто и код 0", async () => {
    await withDb(async (db) => {
      const result = await sheetAliasLsCommand.invoke([], ioOf(db));
      assertEquals(sheetAliasLsCommand.renderResult(result, []), "");
    }, false);
  });
});

Deno.test("alias rm различает исходы", async () => {
  await withDb(async (db) => {
    await sheetAliasAddCommand.invoke(["otchet", SS], ioOf(db));
    const first = await sheetAliasRmCommand.invoke(["otchet"], ioOf(db));
    assertEquals(
      sheetAliasRmCommand.renderResult(first, ["otchet"]),
      `alias 'otchet' снят (был ${SS})\n`,
    );
    assertEquals(aliasRowsOf(db).length, 0);
    // Второй прогон — не молчаливый успех: опечатка в имени иначе
    // читалась бы как «снято» (спека, инвариант 5).
    const err = await assertRejects(
      () => sheetAliasRmCommand.invoke(["otchet"], ioOf(db)),
      DomainError,
    );
    assertStringIncludes(err.message, "otchet");
  });
});

Deno.test("open без листа: ссылка и нетронутый кэш", async () => {
  await withDb(async (db) => {
    const { io, launched } = harness(db, {}, () => {
      throw new Error("webapp не должен спрашиваться без имени листа");
    });
    const before = cacheSnapshot(db);
    const result = await sheetOpenCommand.invoke(["-s", SS], io);
    assertEquals(
      sheetOpenCommand.renderResult(result, []),
      `${URL_OF}${SS}/edit\n`,
    );
    // Открывателю уходит ровно то, что напечатано, а не соседняя форма.
    assertEquals(launched, [`xdg-open ${URL_OF}${SS}/edit`]);
    // Кэш метаданных не изменился — граница потребителя (приёмка спеки).
    assertEquals(cacheSnapshot(db), before);
  });
});

Deno.test("open ЛИСТ: gid числовой, ключ метаданных появился", async () => {
  await withDb(async (db) => {
    const { io, options } = harness(db);
    const result = await runOpen(
      { tab: "Данные", spreadsheet: SS },
      io,
      options,
    );
    // Числовой идентификатор листа, а не его имя: вторая форма ссылки
    // из спеки сверяется дословно.
    assertEquals(result.sheet_id, 42);
    assertEquals(result.url, `${URL_OF}${SS}/edit#gid=42`);
    assertEquals(
      db.query("SELECT key FROM cache WHERE key = ?", infoKey(SS)).length,
      1,
    );
  });
});

Deno.test("open ЛИСТ пользуется кэшем, а не чистит его", async () => {
  await withDb(async (db) => {
    // Ключ метаданных уже есть; сети нет вовсе. Команда обязана взять
    // gid из кэша и оставить ключ на месте: она потребитель, не хозяин.
    const { io, options } = harness(db, {}, () => {
      throw new Error("webapp не должен спрашиваться при готовом кэше");
    });
    db.execute(
      "INSERT INTO cache (key, value, created_at, expires_at)" +
        " VALUES (?, ?, ?, ?)",
      infoKey(SS),
      JSON.stringify([
        { title: "Данные", sheet_id: 42, rows: 10, cols: 3, index: 0 },
      ]),
      1_700_000_000,
      1_900_000_000,
    );
    const result = await runOpen(
      { tab: "Данные", spreadsheet: SS },
      io,
      options,
    );
    assertEquals(result.url, `${URL_OF}${SS}/edit#gid=42`);
    assertEquals(
      db.query("SELECT key FROM cache WHERE key = ?", infoKey(SS)).length,
      1,
    );
  });
});

Deno.test("open ЛИСТ: листа нет — код 2 и перечень доступных", async () => {
  await withDb(async (db) => {
    const { io, options } = harness(db);
    const err = await assertRejects(
      () => runOpen({ tab: "Нетакого", spreadsheet: SS }, io, options),
      UsageError,
    );
    assertStringIncludes(err.message, "Сводка");
    assertStringIncludes(err.message, "Данные");
  });
});

Deno.test("открывателя нет — ссылка всё равно напечатана", async () => {
  await withDb(async (db) => {
    const { io, notes } = harness(db, { launchOpener: () => false });
    const result = await sheetOpenCommand.invoke(["-s", SS], io);
    // Печать от запуска не зависит: ссылка нужна и там, где открывать
    // нечем (спека, «Форма ссылки `open`»).
    assertEquals(
      sheetOpenCommand.renderResult(result, []),
      `${URL_OF}${SS}/edit\n`,
    );
    // …но неуспех назван кодом: молчаливый ноль означал бы, что
    // таблица открыта, а её никто не открывал.
    assertEquals(sheetOpenCommand.textExitCode(result), 1);
    assertEquals(notes.length, 1);
    assertStringIncludes(notes[0], "открывателя нет");
  });
});
