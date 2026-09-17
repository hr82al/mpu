/**
 * Контрактные тесты синка (`docs/specs/update.md`, «Golden-примеры»).
 * Живого PostgreSQL здесь нет и не будет: PG объявлен портом на стороне
 * потребителя, и стенд ниже — его фейковая реализация. Молчание сервера
 * изображается промисом, который резолвит только сигнал отмены: сна
 * стеной в тестах не бывает (`ts/CLAUDE.md`), а пределы прогона тест
 * уменьшает на два порядка.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { openCacheDb } from "../store/mod.ts";
import type { CacheDb } from "../command/mod.ts";
import type { PgRow } from "./cache.ts";
import {
  ClientNotFoundError,
  MainUnavailableError,
  type OpenPgSession,
  type PgLimits,
  type PgSession,
  type SelectOptions,
  syncClient,
  syncSnapshot,
} from "./sync.ts";

/** Пределы тестов: на два порядка меньше продуктовых. */
const LIMITS: PgLimits = { connectMs: 200, queryMs: 200 };

/** Момент записи: фиксированный, чтобы `synced_at` можно было сверить. */
const SYNCED_AT = 1_754_400_000;

/** Выборка: готовые строки либо обработчик (отказ, молчание, ворота). */
type Answer =
  | readonly PgRow[]
  | ((options: SelectOptions) => Promise<readonly PgRow[]>);

/** Что стенд знает о сервере: три выборки и поведение подключения. */
interface FakeServer {
  readonly clients?: Answer;
  readonly spreadsheets?: Answer;
  readonly wbSids?: Answer;
  /** Подключение: по умолчанию открывается сразу. */
  readonly open?: "silent" | Error;
}

/** Фейковый стенд: открыватель сессий и следы обращений к нему. */
interface Stand {
  readonly open: OpenPgSession;
  /** Номера серверов в порядке открытия сессии. */
  readonly opened: readonly number[];
  /** Номера серверов, чьи сессии закрыты. */
  readonly closed: readonly number[];
  /** Имена выборок, которые кто-то позвал, с номером сервера. */
  readonly calls: readonly string[];
}

function fakeStand(
  servers: Readonly<Record<number, FakeServer>>,
): Stand {
  const opened: number[] = [];
  const closed: number[] = [];
  const calls: string[] = [];
  const stand: Stand = {
    opened,
    closed,
    calls,
    open: async (serverNumber, { signal }) => {
      const server = servers[serverNumber];
      if (server === undefined) {
        throw new Error(`нет соединения с sl-${serverNumber}`);
      }
      if (server.open instanceof Error) throw server.open;
      if (server.open === "silent") return await never(signal);
      opened.push(serverNumber);
      const select =
        (name: keyof FakeServer, answer: Answer | undefined) =>
        (options: SelectOptions): Promise<readonly PgRow[]> => {
          calls.push(`sl-${serverNumber}.${name}`);
          if (answer === undefined) return Promise.resolve([]);
          return typeof answer === "function"
            ? answer(options)
            : Promise.resolve(answer);
        };
      const session: PgSession = {
        clients: select("clients", server.clients),
        spreadsheets: select("spreadsheets", server.spreadsheets),
        wbSids: select("wbSids", server.wbSids),
        close: () => {
          closed.push(serverNumber);
          return Promise.resolve();
        },
      };
      return session;
    },
  };
  return stand;
}

/** Ответ, которого не будет: оборвать его может только сигнал отмены. */
function never<T>(signal: AbortSignal): Promise<T> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

/** Выборка, отказывающая названной причиной. */
function fails(reason: string): () => Promise<never> {
  return () => Promise.reject(new Error(reason));
}

/** Строка `public.clients`. */
function client(id: number, server: string | null): PgRow {
  return {
    id,
    server,
    is_active: true,
    is_locked: false,
    is_deleted: false,
  };
}

/** Строка `public.spreadsheets`. */
function spreadsheet(ssId: string, clientId: number): PgRow {
  return {
    spreadsheet_id: ssId,
    client_id: clientId,
    title: `таблица ${ssId}`,
    template_name: null,
    is_active: true,
  };
}

async function withDb(fn: (db: CacheDb) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    await fn(db);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Содержимое таблицы снапшота по возрастанию первого столбца. */
function rowsOf(db: CacheDb, sql: string): readonly PgRow[] {
  return db.query(sql) as readonly PgRow[];
}

Deno.test("happy path: два инстанса, счётчики и строки снапшота", async () => {
  await withDb(async (db) => {
    const stand = fakeStand({
      0: {
        clients: [
          client(101, "sl-1"),
          client(102, "sl-2"),
          client(103, "sl-1"),
        ],
        wbSids: [
          { client_id: 101, sid: "sid-a" },
          { client_id: 102, sid: "sid-b" },
        ],
      },
      1: { spreadsheets: [spreadsheet("ss1", 101), spreadsheet("ss3", 103)] },
      2: { spreadsheets: [spreadsheet("ss2", 102)] },
    });

    const outcome = await syncSnapshot({
      db,
      openPg: stand.open,
      limits: LIMITS,
      syncedAt: SYNCED_AT,
    });

    assertEquals(outcome.clients, 3);
    assertEquals(outcome.spreadsheets, 3);
    assertEquals(outcome.wbSids, 2);
    assertEquals(outcome.servers, 2);
    assertEquals(outcome.failed, []);
    // Сессии закрыты все до одной: main и оба инстанса.
    assertEquals([...stand.opened].sort(), [0, 1, 2]);
    assertEquals([...stand.closed].sort(), [0, 1, 2]);
    // main на таблицы клиентов не опрашивается (инвариант спеки).
    assertEquals(stand.calls.includes("sl-0.spreadsheets"), false);

    assertEquals(
      rowsOf(db, "SELECT client_id, server, synced_at FROM sl_clients"),
      [
        { client_id: 101, server: "sl-1", synced_at: SYNCED_AT },
        { client_id: 102, server: "sl-2", synced_at: SYNCED_AT },
        { client_id: 103, server: "sl-1", synced_at: SYNCED_AT },
      ],
    );
    assertEquals(
      rowsOf(db, "SELECT ss_id, server FROM sl_spreadsheets ORDER BY ss_id"),
      [
        { ss_id: "ss1", server: "sl-1" },
        { ss_id: "ss2", server: "sl-2" },
        { ss_id: "ss3", server: "sl-1" },
      ],
    );
    assertEquals(
      rowsOf(db, "SELECT sid, client_id, server FROM sl_wb_sids ORDER BY sid"),
      [
        { sid: "sid-a", client_id: 101, server: "sl-1" },
        { sid: "sid-b", client_id: 102, server: "sl-2" },
      ],
    );
  });
});

Deno.test("сбой инстанса: предупреждение и счётчики только с живых", async () => {
  await withDb(async (db) => {
    const stand = fakeStand({
      0: { clients: [client(101, "sl-1"), client(102, "sl-2")] },
      1: { spreadsheets: [spreadsheet("ss1", 101)] },
      2: { spreadsheets: fails("connection refused\nвторая строка") },
    });

    const outcome = await syncSnapshot({
      db,
      openPg: stand.open,
      limits: LIMITS,
      syncedAt: SYNCED_AT,
    });

    // Многострочное сообщение сжато до первой строки (спека).
    assertEquals(outcome.failed, [
      { serverNumber: 2, reason: "connection refused" },
    ]);
    assertEquals(outcome.servers, 1);
    assertEquals(outcome.spreadsheets, 1);
    assertEquals(outcome.clients, 2);
  });
});

Deno.test("сбой всех инстансов: клиенты записаны, таблиц нет, exit не меняется", async () => {
  await withDb(async (db) => {
    // sl-3 назван первым намеренно: порядок предупреждения — по
    // возрастанию номера, а не по порядку появления в выборке.
    const stand = fakeStand({
      0: {
        clients: [
          client(103, "sl-3"),
          client(101, "sl-1"),
          client(102, "sl-2"),
        ],
      },
    });

    const outcome = await syncSnapshot({
      db,
      openPg: stand.open,
      limits: LIMITS,
      syncedAt: SYNCED_AT,
    });

    assertEquals(outcome.failed, [
      { serverNumber: 1, reason: "нет соединения с sl-1" },
      { serverNumber: 2, reason: "нет соединения с sl-2" },
      { serverNumber: 3, reason: "нет соединения с sl-3" },
    ]);
    assertEquals(outcome.servers, 0);
    assertEquals(outcome.spreadsheets, 0);
    assertEquals(outcome.clients, 3);
    assertEquals(rowsOf(db, "SELECT ss_id FROM sl_spreadsheets"), []);
  });
});

Deno.test("недоступный main: отказ, кэш не изменён", async (t) => {
  const cases: readonly (readonly [string, FakeServer, string])[] = [
    [
      "подключение",
      { open: new Error("ECONNREFUSED 10.0.0.1:5432") },
      "main (sl-0) недоступен: ECONNREFUSED 10.0.0.1:5432",
    ],
    [
      "выборка клиентов",
      { clients: fails("relation clients does not exist") },
      "main (sl-0) недоступен: relation clients does not exist",
    ],
    [
      "выборка sid'ов",
      { clients: [client(101, "sl-0")], wbSids: fails("боль") },
      "main (sl-0) недоступен: боль",
    ],
  ];
  for (const [name, main, message] of cases) {
    await t.step(name, async () => {
      await withDb(async (db) => {
        // В кэше уже лежит прошлый снапшот: отказ не должен его тронуть.
        db.bootstrap();
        db.execute(
          "INSERT INTO sl_clients (client_id, server, is_active, is_locked," +
            " is_deleted, synced_at) VALUES (7, 'sl-9', 1, 0, 0, 1)",
        );
        const stand = fakeStand({ 0: main });
        const err = await assertRejects(
          () =>
            syncSnapshot({
              db,
              openPg: stand.open,
              limits: LIMITS,
              syncedAt: SYNCED_AT,
            }),
          MainUnavailableError,
        );
        assertEquals(err.message, message);
        assertEquals(
          rowsOf(db, "SELECT client_id, server FROM sl_clients"),
          [{ client_id: 7, server: "sl-9" }],
        );
      });
    });
  }
});

Deno.test("повторный прогон: снапшот замещается целиком", async () => {
  await withDb(async (db) => {
    const first = fakeStand({
      0: {
        clients: [client(101, "sl-1")],
        wbSids: [{ client_id: 101, sid: "sid-a" }],
      },
      1: { spreadsheets: [spreadsheet("ss1", 101)] },
    });
    await syncSnapshot({
      db,
      openPg: first.open,
      limits: LIMITS,
      syncedAt: SYNCED_AT,
    });

    const second = fakeStand({
      0: {
        clients: [client(202, "sl-2")],
        wbSids: [{ client_id: 202, sid: "sid-z" }],
      },
      2: { spreadsheets: [spreadsheet("ss9", 202)] },
    });
    await syncSnapshot({
      db,
      openPg: second.open,
      limits: LIMITS,
      syncedAt: SYNCED_AT + 60,
    });

    // Ни одной строки прошлого прогона (инвариант спеки).
    assertEquals(rowsOf(db, "SELECT client_id FROM sl_clients"), [{
      client_id: 202,
    }]);
    assertEquals(rowsOf(db, "SELECT ss_id FROM sl_spreadsheets"), [{
      ss_id: "ss9",
    }]);
    assertEquals(rowsOf(db, "SELECT sid FROM sl_wb_sids"), [{ sid: "sid-z" }]);
  });
});

Deno.test("молчащий инстанс: предупреждение и ограниченное время", async (t) => {
  const cases: readonly (readonly [string, FakeServer, string])[] = [
    ["молчит подключение", { open: "silent" }, "нет соединения за 120ms"],
    [
      "молчит запрос",
      { spreadsheets: ({ signal }) => never(signal) },
      "нет ответа за 120ms",
    ],
  ];
  for (const [name, silent, reason] of cases) {
    await t.step(name, async () => {
      await withDb(async (db) => {
        const stand = fakeStand({
          0: { clients: [client(101, "sl-1"), client(102, "sl-2")] },
          1: { spreadsheets: [spreadsheet("ss1", 101)] },
          2: silent,
        });
        // Фейковые часы вместо стенных: таймер предела времени внутри
        // `withDeadline` — обычный `setTimeout`, `FakeTime` его
        // подменяет. Продвигаем ровно на предел — без сна и без гонки
        // с реальным временем выполнения теста.
        using time = new FakeTime();
        const outcome = await Promise.all([
          syncSnapshot({
            db,
            openPg: stand.open,
            limits: { connectMs: 120, queryMs: 120 },
            syncedAt: SYNCED_AT,
          }),
          time.tickAsync(120),
        ]).then(([result]) => result);

        assertEquals(outcome.failed, [{ serverNumber: 2, reason }]);
        // Живой инстанс не пострадал молчанием соседа.
        assertEquals(outcome.spreadsheets, 1);
      });
    });
  }
});

Deno.test("фан-аут конкурентен: последовательный обход не завершился бы", async () => {
  await withDb(async (db) => {
    // Ворота: каждая выборка ждёт, пока стартуют все три. Обход по
    // очереди упёрся бы в предел запроса на первом же инстансе.
    const arrived = Promise.withResolvers<void>();
    let started = 0;
    const gate = (): Promise<readonly PgRow[]> => {
      started++;
      if (started === 3) arrived.resolve();
      return arrived.promise.then(() => []);
    };
    const stand = fakeStand({
      0: {
        clients: [
          client(101, "sl-1"),
          client(102, "sl-2"),
          client(103, "sl-3"),
        ],
      },
      1: { spreadsheets: gate },
      2: { spreadsheets: gate },
      3: { spreadsheets: gate },
    });

    const outcome = await syncSnapshot({
      db,
      openPg: stand.open,
      limits: LIMITS,
      syncedAt: SYNCED_AT,
    });

    assertEquals(outcome.servers, 3);
    assertEquals(outcome.failed, []);
  });
});

Deno.test("точечный синк: клиент найден, соседи не тронуты", async () => {
  await withDb(async (db) => {
    const full = fakeStand({
      0: {
        clients: [client(101, "sl-1"), client(102, "sl-1")],
        wbSids: [
          { client_id: 101, sid: "sid-a" },
          { client_id: 102, sid: "sid-b" },
        ],
      },
      1: { spreadsheets: [spreadsheet("ss1", 101), spreadsheet("ss2", 102)] },
    });
    await syncSnapshot({
      db,
      openPg: full.open,
      limits: LIMITS,
      syncedAt: SYNCED_AT,
    });

    const point = fakeStand({
      0: {
        clients: [{ ...client(101, "sl-1"), is_locked: true }],
        wbSids: [{ client_id: 101, sid: "sid-new" }],
      },
      1: { spreadsheets: [spreadsheet("ss1", 101)] },
    });
    const outcome = await syncClient({
      db,
      openPg: point.open,
      limits: LIMITS,
      syncedAt: SYNCED_AT + 60,
      clientId: 101,
    });

    assertEquals(outcome, { server: "sl-1", spreadsheets: 1, wbSids: 1 });
    assertEquals(
      rowsOf(db, "SELECT client_id, is_locked, synced_at FROM sl_clients"),
      [
        { client_id: 101, is_locked: 1, synced_at: SYNCED_AT + 60 },
        // Соседний клиент не тронут — ни значениями, ни временем синка.
        { client_id: 102, is_locked: 0, synced_at: SYNCED_AT },
      ],
    );
    // Строки соседа на месте, исчезнувших строк клиента не удаляли.
    assertEquals(
      rowsOf(db, "SELECT sid FROM sl_wb_sids ORDER BY sid"),
      [{ sid: "sid-a" }, { sid: "sid-b" }, { sid: "sid-new" }],
    );
  });
});

Deno.test("точечный синк: клиент не найден — отказ без записи", async () => {
  await withDb(async (db) => {
    const stand = fakeStand({ 0: { clients: [] } });
    await assertRejects(
      () =>
        syncClient({
          db,
          openPg: stand.open,
          limits: LIMITS,
          syncedAt: SYNCED_AT,
          clientId: 404,
        }),
      ClientNotFoundError,
      "клиент 404 не найден",
    );
    db.bootstrap();
    assertEquals(rowsOf(db, "SELECT client_id FROM sl_clients"), []);
  });
});

Deno.test("точечный синк: сбой части не мешает записать остальное", async (t) => {
  const cases: readonly (readonly [string, FakeServer, FakeServer, {
    spreadsheets: number | null;
    wbSids: number | null;
  }])[] = [
    [
      "сбой части 2 (таблицы клиента)",
      {
        clients: [client(101, "sl-1")],
        wbSids: [{ client_id: 101, sid: "sid-a" }],
      },
      { spreadsheets: fails("боль") },
      { spreadsheets: null, wbSids: 1 },
    ],
    [
      "сбой части 3 (sid'ы клиента)",
      { clients: [client(101, "sl-1")], wbSids: fails("боль") },
      { spreadsheets: [spreadsheet("ss1", 101)] },
      { spreadsheets: 1, wbSids: null },
    ],
  ];
  for (const [name, main, instance, expected] of cases) {
    await t.step(name, async () => {
      await withDb(async (db) => {
        const stand = fakeStand({ 0: main, 1: instance });
        const outcome = await syncClient({
          db,
          openPg: stand.open,
          limits: LIMITS,
          syncedAt: SYNCED_AT,
          clientId: 101,
        });
        assertEquals(outcome.spreadsheets, expected.spreadsheets);
        assertEquals(outcome.wbSids, expected.wbSids);
        // Клиент записан в любом случае — упала только его часть.
        assertEquals(rowsOf(db, "SELECT client_id FROM sl_clients"), [{
          client_id: 101,
        }]);
      });
    });
  }
});

Deno.test("точечный синк: клиент на sl-0 — таблицы не запрашиваются", async () => {
  await withDb(async (db) => {
    const stand = fakeStand({
      0: {
        clients: [client(101, "sl-0")],
        wbSids: [{ client_id: 101, sid: "sid-a" }],
      },
    });
    const outcome = await syncClient({
      db,
      openPg: stand.open,
      limits: LIMITS,
      syncedAt: SYNCED_AT,
      clientId: 101,
    });

    assertEquals(outcome, { server: "sl-0", spreadsheets: null, wbSids: 1 });
    // Ни одной выборки таблиц: main на spreadsheets не опрашивается.
    assertEquals(stand.calls.includes("sl-0.spreadsheets"), false);
    // Имя сервера в записях — исходная строка `server` (спека).
    assertEquals(
      rowsOf(db, "SELECT client_id, server FROM sl_wb_sids"),
      [{ client_id: 101, server: "sl-0" }],
    );
  });
});
