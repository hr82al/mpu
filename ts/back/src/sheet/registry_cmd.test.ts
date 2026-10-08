/**
 * Реестр таблиц (`docs/specs/sheet-registry.md`): алиасы и `open`.
 *
 * Кэш-БД настоящая, во временном каталоге: проверяется след — строки
 * `sheet_aliases` и ключ `sheet:info:<ss_id>`, — а не код возврата.
 * Ссылка сверяется дословно: запуск открывателя отсюда недостижим, и
 * она единственное, что проверяемо здесь.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
import { makeFakeIo, plainRows } from "@mpu/command/testing";
import {
  type CacheDb,
  type CommandIo,
  DomainError,
  NotFoundIoError,
  UsageError,
} from "@mpu/command";
import { openCacheDb } from "@mpu/command/store";
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
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    if (bootstrap) db.bootstrap();
    await body(db);
  } finally {
    await rm(dir, { recursive: true });
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
  post: (
    url: string,
    body: string,
  ) => Promise<{ status: number; text: string }> = () =>
    Promise.resolve(tabsReply()),
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

/** Строки реестра как обычные записи (`plainRows`). */
const aliasRowsOf = (db: CacheDb) =>
  plainRows(db.query("SELECT name, ss_id FROM sheet_aliases ORDER BY name"));

it("alias add поверх существующего имени обновляет строку", async () => {
  await withDb(async (db) => {
    const firstArgv = ["otchet", SS];
    const first = await sheetAliasAddCommand.invoke(firstArgv, ioOf(db));
    expect(sheetAliasAddCommand.renderResult(first, firstArgv)).toStrictEqual(
      `alias 'otchet' → ${SS}\n`,
    );
    const secondArgv = ["otchet", OTHER];
    const second = await sheetAliasAddCommand.invoke(secondArgv, ioOf(db));
    // Строк не прибавилось, идентификатор сменился — обе половины
    // требования спеки («Хранилище»), и вторая без первой ничего не
    // значит: две строки на имя тоже «сменили бы» идентификатор.
    expect(aliasRowsOf(db)).toStrictEqual([{ name: "otchet", ss_id: OTHER }]);
    // Вывод называет обе стороны замены: без прежнего значения
    // оператор не увидит единственного, что мог сделать не так.
    expect(sheetAliasAddCommand.renderResult(second, secondArgv)).toStrictEqual(
      `alias 'otchet': ${SS} → ${OTHER}\n`,
    );
  });
});

describe("alias add: что отвергается до записи", () => {
  it("недопустимое имя", async () => {
    await withDb(async (db) => {
      const err = await rejected(
        () => sheetAliasAddCommand.invoke(["от чёт", SS], ioOf(db)),
        UsageError,
      );
      // Отказ называет допустимый набор: иначе оператор перебирает.
      expect(err.message).toContain("буквы, цифры");
      expect(aliasRowsOf(db).length).toBe(0);
    });
  });

  it("ТАБЛИЦА не идентификатор и не ссылка", async () => {
    await withDb(async (db) => {
      await expect(
        sheetAliasAddCommand.invoke(["otchet", "Отчёт за май"], ioOf(db)),
      ).rejects.toThrow(UsageError);
      expect(aliasRowsOf(db).length).toBe(0);
    });
  });

  it("ссылка принимается, в реестр идёт идентификатор", async () => {
    await withDb(async (db) => {
      await sheetAliasAddCommand.invoke(
        ["otchet", `${URL_OF}${SS}/edit#gid=0`],
        ioOf(db),
      );
      expect(aliasRowsOf(db)).toStrictEqual([{ name: "otchet", ss_id: SS }]);
    });
  });

  it("короткий хвост ссылки идентификатором не станет", async () => {
    await withDb(async (db) => {
      await expect(
        sheetAliasAddCommand.invoke(["otchet", `${URL_OF}abc/edit`], ioOf(db)),
      ).rejects.toThrow(UsageError);
      expect(aliasRowsOf(db).length).toBe(0);
    });
  });
});

describe("alias ls: по имени, пустой реестр — пустой вывод", () => {
  it("сортировка по имени", async () => {
    await withDb(async (db) => {
      await sheetAliasAddCommand.invoke(["vtoroj", OTHER], ioOf(db));
      await sheetAliasAddCommand.invoke(["altyj", SS], ioOf(db));
      const result = await sheetAliasLsCommand.invoke([], ioOf(db));
      expect(sheetAliasLsCommand.renderResult(result, [])).toStrictEqual(
        `altyj\t${SS}\nvtoroj\t${OTHER}\n`,
      );
    });
  });

  it("пустой реестр", async () => {
    await withDb(async (db) => {
      const result = await sheetAliasLsCommand.invoke([], ioOf(db));
      expect(sheetAliasLsCommand.renderResult(result, [])).toBe("");
    });
  });

  it("таблицы алиасов нет вовсе — тоже пусто и код 0", async () => {
    await withDb(async (db) => {
      const result = await sheetAliasLsCommand.invoke([], ioOf(db));
      expect(sheetAliasLsCommand.renderResult(result, [])).toBe("");
    }, false);
  });
});

it("alias rm различает исходы", async () => {
  await withDb(async (db) => {
    await sheetAliasAddCommand.invoke(["otchet", SS], ioOf(db));
    const first = await sheetAliasRmCommand.invoke(["otchet"], ioOf(db));
    expect(sheetAliasRmCommand.renderResult(first, ["otchet"])).toStrictEqual(
      `alias 'otchet' снят (был ${SS})\n`,
    );
    expect(aliasRowsOf(db).length).toBe(0);
    // Второй прогон — не молчаливый успех: опечатка в имени иначе
    // читалась бы как «снято» (спека, инвариант 5).
    const err = await rejected(
      () => sheetAliasRmCommand.invoke(["otchet"], ioOf(db)),
      DomainError,
    );
    expect(err.message).toContain("otchet");
  });
});

it("open без листа: ссылка и нетронутый кэш", async () => {
  await withDb(async (db) => {
    const { io, launched } = harness(db, {}, () => {
      throw new Error("webapp не должен спрашиваться без имени листа");
    });
    const before = cacheSnapshot(db);
    const result = await sheetOpenCommand.invoke(["-s", SS], io);
    expect(sheetOpenCommand.renderResult(result, [])).toStrictEqual(
      `${URL_OF}${SS}/edit\n`,
    );
    // Открывателю уходит ровно то, что напечатано, а не соседняя форма.
    expect(launched).toStrictEqual([`xdg-open ${URL_OF}${SS}/edit`]);
    // Кэш метаданных не изменился — граница потребителя (приёмка спеки).
    expect(cacheSnapshot(db)).toStrictEqual(before);
  });
});

it("open ЛИСТ: gid числовой, ключ метаданных появился", async () => {
  await withDb(async (db) => {
    const { io, options } = harness(db);
    const result = await runOpen(
      { tab: "Данные", spreadsheet: SS },
      io,
      options,
    );
    // Числовой идентификатор листа, а не его имя: вторая форма ссылки
    // из спеки сверяется дословно.
    expect(result.sheet_id).toBe(42);
    expect(result.url).toStrictEqual(`${URL_OF}${SS}/edit#gid=42`);
    expect(
      db.query("SELECT key FROM cache WHERE key = ?", infoKey(SS)).length,
    ).toBe(1);
  });
});

it("open ЛИСТ пользуется кэшем, а не чистит его", async () => {
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
    expect(result.url).toStrictEqual(`${URL_OF}${SS}/edit#gid=42`);
    expect(
      db.query("SELECT key FROM cache WHERE key = ?", infoKey(SS)).length,
    ).toBe(1);
  });
});

it("open ЛИСТ: листа нет — код 2 и перечень доступных", async () => {
  await withDb(async (db) => {
    const { io, options } = harness(db);
    const err = await rejected(
      () => runOpen({ tab: "Нетакого", spreadsheet: SS }, io, options),
      UsageError,
    );
    expect(err.message).toContain("Сводка");
    expect(err.message).toContain("Данные");
  });
});

it("открывателя нет — ссылка всё равно напечатана", async () => {
  await withDb(async (db) => {
    const { io, notes } = harness(db, { launchOpener: () => false });
    const result = await sheetOpenCommand.invoke(["-s", SS], io);
    // Печать от запуска не зависит: ссылка нужна и там, где открывать
    // нечем (спека, «Форма ссылки `open`»).
    expect(sheetOpenCommand.renderResult(result, [])).toStrictEqual(
      `${URL_OF}${SS}/edit\n`,
    );
    // …но неуспех назван кодом: молчаливый ноль означал бы, что
    // таблица открыта, а её никто не открывал.
    expect(sheetOpenCommand.textExitCode(result)).toBe(1);
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain("открывателя нет");
  });
});
