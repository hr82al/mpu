/**
 * Локальный режим `mpu search` (`docs/specs/search.md`): поиск по
 * синтетическому кэшу голденов канала и правило автосинка. Кэш-БД —
 * настоящий SQLite во временном каталоге (как в `../selector/resolve_test.ts`
 * и `../nodecli/cmd_test.ts`), подставной io — `makeFakeIo`
 * (`../testing/mod.ts`). Сети нет ни на одном пути: догоняющий синк
 * подменяется фейком-счётчиком, живого PostgreSQL в тестах нет.
 *
 * Конфиг клиентов синтетический, тот же, что снимал голдены канала
 * (спека, «Golden-примеры»): сервер `sl-9` (`10.9.9.9`/`10.9.9.10`),
 * клиент 10 — таблицы `SS_ALPHA_0001`/`SS_ALPHA_0002`, оба кабинета
 * клиента; клиент 11 — таблица `SS_BETA_0001`, третий кабинет.
 */

import { assert, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CacheDb,
  DomainError,
  formatCommandError,
  UsageError,
} from "../command/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import {
  runSearch,
  type SearchArgs,
  searchCommand,
  type SearchResult,
} from "./mod.ts";

/** Env-файл эталонов канала: адреса девятого сервера. */
const ENV: Readonly<Record<string, string>> = {
  sl_9: "10.9.9.9",
  pg_9: "10.9.9.10",
};

const SID_ALPHA_1 = "00000000-0000-4000-8000-000000000001";
const SID_ALPHA_2 = "00000000-0000-4000-8000-000000000002";
const SID_BETA = "00000000-0000-4000-8000-000000000003";

/** Кэш-БД синтетического конфига голденов: клиенты 10 и 11 на sl-9. */
async function withCache(
  body: (db: CacheDb) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    for (const clientId of [10, 11]) {
      db.execute(
        "INSERT INTO sl_clients (client_id, server, is_active, is_locked," +
          " is_deleted, synced_at) VALUES (?, ?, 1, 0, 0, ?)",
        clientId,
        "sl-9",
        1_700_000_000,
      );
    }
    for (
      const [ssId, clientId, title] of [
        ["SS_ALPHA_0001", 10, "Пример Альфа"],
        ["SS_ALPHA_0002", 10, "Пример Альфа Ozon"],
        ["SS_BETA_0001", 11, "Пример Бета"],
      ] as const
    ) {
      db.execute(
        "INSERT INTO sl_spreadsheets (ss_id, client_id, title, is_active," +
          " server, synced_at) VALUES (?, ?, ?, 1, ?, ?)",
        ssId,
        clientId,
        title,
        "sl-9",
        1_700_000_000,
      );
    }
    for (
      const [sid, clientId] of [
        [SID_ALPHA_1, 10],
        [SID_ALPHA_2, 10],
        [SID_BETA, 11],
      ] as const
    ) {
      db.execute(
        "INSERT INTO sl_wb_sids (sid, client_id, server, synced_at)" +
          " VALUES (?, ?, NULL, ?)",
        sid,
        clientId,
        1_700_000_000,
      );
    }
    await body(db);
  } finally {
    await rm(dir, { recursive: true });
  }
}

/** Окружение вызова: env-файл голденов, счётчик открытий кэш-БД. */
function harness(db: CacheDb, env: Readonly<Record<string, string>> = ENV) {
  let opens = 0;
  const io = makeFakeIo({
    env: () => undefined,
    envFile: {
      get: (name) => env[name],
      values: () => ({ ...env }),
      require: (name) => env[name] ?? "",
      set: () => Promise.reject(new Error("запись env-файла не ожидается")),
    },
    openCacheDb: () => {
      opens++;
      return { ...db, [Symbol.dispose]: () => {} };
    },
    progress: () => {},
  });
  return { io, opens: () => opens };
}

/** Копия эталона канала как есть — без подстановок. */
function golden(name: string): Promise<string> {
  return readFile(new URL(`./testdata/${name}`, import.meta.url), "utf8");
}

/** Полные аргументы команды: всё, кроме названного, — умолчания схемы. */
function searchArgs(overrides: Partial<SearchArgs> = {}): SearchArgs {
  return {
    value: "10",
    "client-id": false,
    "spreadsheet-id": false,
    title: false,
    server: false,
    "server-number": false,
    "sl-ip": false,
    "pg-ip": false,
    sids: false,
    update: true,
    reason: undefined,
    "refresh-cache": false,
    scope: "auto",
    ...overrides,
  };
}

/* --------------------------------------------------------------- *
 * Локальный режим: сверка с эталонами канала через invokeInput +
 * renderResult — тот же путь, что видит CLI.
 * --------------------------------------------------------------- */

it("local: happy path — эталон канала", async () => {
  await withCache(async (db) => {
    const { io } = harness(db);
    const result = await searchCommand.invokeInput(
      { value: "10", update: false },
      io,
    ) as SearchResult;
    expect(searchCommand.renderResult(result, ["10", "--no-update"]))
      .toStrictEqual(await golden("local-happy.stdout.txt"));
  });
});

it("local: проекция --client-id — эталон канала", async () => {
  await withCache(async (db) => {
    const { io } = harness(db);
    const result = await searchCommand.invokeInput(
      { value: "10", update: false, "client-id": true },
      io,
    ) as SearchResult;
    expect(
      searchCommand.renderResult(result, ["10", "--no-update", "--client-id"]),
    ).toStrictEqual(await golden("local-projection-client-id.stdout.txt"));
  });
});

it("local: проекция --sids — эталон канала", async () => {
  await withCache(async (db) => {
    const { io } = harness(db);
    const result = await searchCommand.invokeInput(
      { value: "10", update: false, sids: true },
      io,
    ) as SearchResult;
    expect(searchCommand.renderResult(result, ["10", "--no-update", "--sids"]))
      .toStrictEqual(await golden("local-projection-sids.stdout.txt"));
  });
});

it("local: адрес сервера из env-файла — эталон канала", async () => {
  await withCache(async (db) => {
    const { io } = harness(db);
    const result = await searchCommand.invokeInput(
      { value: "10.9.9.9", update: false },
      io,
    ) as SearchResult;
    expect(searchCommand.renderResult(result, ["10.9.9.9", "--no-update"]))
      .toStrictEqual(await golden("local-ip.stdout.txt"));
  });
});

it("local: поиск по кабинету целиком — эталон канала", async () => {
  await withCache(async (db) => {
    const { io } = harness(db);
    const result = await searchCommand.invokeInput(
      { value: SID_BETA, update: false },
      io,
    ) as SearchResult;
    expect(searchCommand.renderResult(result, [SID_BETA, "--no-update"]))
      .toStrictEqual(await golden("local-sid.stdout.txt"));
  });
});

it("local: остальные проекции — голое значение по строке", async () => {
  // Голденов канала на эти пять проекций нет: сама сборка строки
  // (`row.ts`) проверяется по эталонам client-id/sids, здесь только
  // остальные ветки `projectionOf`.
  await withCache(async (db) => {
    const { io } = harness(db);
    const cases: readonly [Partial<SearchArgs>, string][] = [
      [{ title: true }, "Пример Бета\n"],
      [{ server: true }, "sl-9\n"],
      [{ "server-number": true }, "9\n"],
      [{ "sl-ip": true }, "10.9.9.9\n"],
      [{ "pg-ip": true }, "10.9.9.10\n"],
    ];
    for (const [flag, expected] of cases) {
      const result = await searchCommand.invokeInput(
        { value: SID_BETA, update: false, ...flag },
        io,
      ) as SearchResult;
      expect(searchCommand.renderResult(result, [SID_BETA, "--no-update"]))
        .toStrictEqual(expected);
    }
  });
});

it("local: числовой селектор — всегда client_id, поиск по кабинету недостижим", async () => {
  // "40008000" — куски третьей и четвёртой группы SID_ALPHA_1
  // (`4000-8000`) без разделителя: цифры трактуются как client_id
  // (отклонение `preserve`, спека «Известные отклонения»), и до
  // подстрочного поиска по кабинету дело не доходит — пустой результат,
  // а не найденная таблица.
  await withCache(async (db) => {
    const { io } = harness(db);
    const result = await searchCommand.invokeInput(
      { value: "40008000", update: false },
      io,
    ) as SearchResult;
    expect(searchCommand.renderResult(result, ["40008000", "--no-update"]))
      .toStrictEqual(await golden("local-numeric-not-sid.stdout.txt"));
  });
});

it("local: ничего не найдено — эталон канала", async () => {
  await withCache(async (db) => {
    const { io } = harness(db);
    const result = await searchCommand.invokeInput(
      { value: "нет-такого-клиента", update: false },
      io,
    ) as SearchResult;
    expect(
      searchCommand.renderResult(result, ["нет-такого-клиента", "--no-update"]),
    ).toStrictEqual(await golden("local-empty.stdout.txt"));
  });
});

it("две проекции сразу — отказ до всякого обращения к БД", async () => {
  // `openCacheDb`, бросающий исключение: если бы отказ случился позже
  // проверки флагов, тест упал бы на этом исключении, а не на
  // ожидаемом UsageError.
  const io = makeFakeIo({
    openCacheDb: () => {
      throw new Error("кэш-БД не должна открываться");
    },
  });
  const err = await searchCommand.invokeInput(
    { value: "10", "client-id": true, sids: true },
    io,
  ).catch((thrown: unknown) => thrown);
  assert(err instanceof UsageError);
  expect(`${formatCommandError("search", err)}\n`).toStrictEqual(
    await golden("err-two-projections.stderr.txt"),
  );
});

/* --------------------------------------------------------------- *
 * Автосинк: `runSearch` с подменённым `sync` — живого PostgreSQL в
 * тестах нет, поэтому синк подменяется фейком-счётчиком, который сам
 * решает, наполнить кэш или нет.
 * --------------------------------------------------------------- */

it("автосинк: пустой результат — синк ровно один раз, повтор находит", async () => {
  await withCache(async (db) => {
    const { io } = harness(db);
    let calls = 0;
    const result = await runSearch(
      searchArgs({ value: "99" }),
      io,
      {
        sync: (syncIo) => {
          calls++;
          using cacheDb = syncIo.openCacheDb();
          cacheDb.execute(
            "INSERT INTO sl_clients (client_id, server, is_active," +
              " is_locked, is_deleted, synced_at) VALUES (?, ?, 1, 0, 0, ?)",
            99,
            "sl-9",
            1_700_000_000,
          );
          return Promise.resolve();
        },
      },
    );
    expect(calls).toBe(1);
    expect(result.synced).toBe(true);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].client_id).toBe(99);
  });
});

it("автосинк: повторно пустой результат — синк не повторяется", async () => {
  await withCache(async (db) => {
    const { io } = harness(db);
    let calls = 0;
    const result = await runSearch(
      searchArgs({ value: "нет-такого-клиента" }),
      io,
      {
        sync: () => {
          calls++;
          return Promise.resolve();
        },
      },
    );
    expect(calls).toBe(1);
    expect(result.rows).toStrictEqual([]);
    expect(result.synced).toBe(true);
  });
});

it("--no-update: синк не вызывается", async () => {
  await withCache(async (db) => {
    const { io } = harness(db);
    let calls = 0;
    const result = await runSearch(
      searchArgs({ value: "нет-такого-клиента", update: false }),
      io,
      {
        sync: () => {
          calls++;
          return Promise.resolve();
        },
      },
    );
    expect(calls).toBe(0);
    expect(result.synced).toBe(false);
    expect(result.rows).toStrictEqual([]);
  });
});

it("селектор-адрес вне env-файла: синк не вызывается", async () => {
  // Мутационная точка: адрес живёт в env-файле, а не в кэше, и синк
  // снапшота клиентов ему не поможет (спека, «Локальный режим»).
  await withCache(async (db) => {
    const { io } = harness(db);
    let calls = 0;
    const result = await runSearch(
      searchArgs({ value: "10.1.2.3" }),
      io,
      {
        sync: () => {
          calls++;
          return Promise.resolve();
        },
      },
    );
    expect(calls).toBe(0);
    expect(result.rows).toStrictEqual([]);
    expect(result.synced).toBe(false);
  });
});

it("сбой синка: ошибка пробрасывается, повторного поиска нет", async () => {
  await withCache(async (db) => {
    const { io, opens } = harness(db);
    await expect(runSearch(
      searchArgs({ value: "нет-такого-клиента" }),
      io,
      {
        sync: () => {
          throw new DomainError("main недоступен");
        },
      },
    )).rejects.toThrow(DomainError);
    // Ровно одно открытие кэш-БД — от первого поиска; сбой синка не
    // должен запускать второй проход.
    expect(opens()).toBe(1);
  });
});
