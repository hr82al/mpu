/**
 * Тесты `cache.ts` (`docs/specs/update.md`): формы строк снапшота (разбор
 * выборок PG в них — `read*Rows`) и запись в кэш-БД (`writeSnapshot`,
 * точечный `upsertClient`). Кэш-БД — временный файл SQLite через
 * `openCacheDb` (как в `../store/mod.test.ts`).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { plainRows } from "../testing/cache.ts";
import { thrown } from "../testing/thrown.ts";
import { openCacheDb } from "../store/mod.ts";
import {
  type ClientRow,
  type PgRow,
  PgRowError,
  type PgValue,
  readClientRows,
  readSpreadsheetRows,
  readWbSidRows,
  type Snapshot,
  type SpreadsheetRow,
  upsertClient,
  writeSnapshot,
} from "./cache.ts";
import type { CacheDb } from "../command/mod.ts";

/** Временная кэш-БД с уборкой: у каждого теста своя, файл живёт в $TMPDIR. */
async function withDb(fn: (db: CacheDb) => void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    fn(db);
  } finally {
    await rm(dir, { recursive: true });
  }
}

describe("readClientRows: перенос полей и приведение флагов к 0/1", () => {
  const cases: readonly (readonly [string, PgRow, ClientRow])[] = [
    [
      "флаги true/false, server как есть",
      {
        id: 1,
        server: "sl-1",
        is_active: true,
        is_locked: false,
        is_deleted: false,
      },
      { clientId: 1, server: "sl-1", isActive: 1, isLocked: 0, isDeleted: 0 },
    ],
    [
      "server NULL остаётся null",
      {
        id: 2,
        server: null,
        is_active: true,
        is_locked: true,
        is_deleted: false,
      },
      { clientId: 2, server: null, isActive: 1, isLocked: 1, isDeleted: 0 },
    ],
    [
      "флаг NULL → 0",
      {
        id: 3,
        server: "sl-2",
        is_active: null,
        is_locked: false,
        is_deleted: false,
      },
      { clientId: 3, server: "sl-2", isActive: 0, isLocked: 0, isDeleted: 0 },
    ],
    [
      "число 1 в флаге → 1",
      { id: 4, server: "sl-2", is_active: 1, is_locked: 0, is_deleted: 0 },
      { clientId: 4, server: "sl-2", isActive: 1, isLocked: 0, isDeleted: 0 },
    ],
  ];
  for (const [name, row, expected] of cases) {
    it(name, () => {
      expect(readClientRows([row])).toStrictEqual([expected]);
    });
  }
});

it("readClientRows: нечисловой id — PgRowError с именем колонки", () => {
  thrown(
    () =>
      readClientRows([
        {
          id: "abc",
          server: null,
          is_active: true,
          is_locked: false,
          is_deleted: false,
        },
      ]),
    PgRowError,
    "clients.id",
  );
});

describe("readSpreadsheetRows: заголовок, имя шаблона и флаг активности", () => {
  const cases: readonly (readonly [string, PgRow, SpreadsheetRow])[] = [
    [
      "NULL заголовок → пустая строка (колонка кэша NOT NULL)",
      {
        spreadsheet_id: "ss1",
        client_id: 1,
        title: null,
        template_name: null,
        is_active: true,
      },
      {
        ssId: "ss1",
        clientId: 1,
        title: "",
        templateName: null,
        isActive: 1,
        server: "sl-1",
      },
    ],
    [
      "пустой заголовок → пустая строка, template_name сохраняется",
      {
        spreadsheet_id: "ss2",
        client_id: 1,
        title: "",
        template_name: "shop",
        is_active: false,
      },
      {
        ssId: "ss2",
        clientId: 1,
        title: "",
        templateName: "shop",
        isActive: 0,
        server: "sl-1",
      },
    ],
    [
      "непустой заголовок переносится как есть",
      {
        spreadsheet_id: "ss3",
        client_id: 2,
        title: "Отчёт",
        template_name: "shop",
        is_active: true,
      },
      {
        ssId: "ss3",
        clientId: 2,
        title: "Отчёт",
        templateName: "shop",
        isActive: 1,
        server: "sl-1",
      },
    ],
  ];
  for (const [name, row, expected] of cases) {
    it(name, () => {
      expect(readSpreadsheetRows([row], "sl-1")).toStrictEqual([expected]);
    });
  }
});

it("readSpreadsheetRows: параметр server проставляется во все строки как пришёл", () => {
  const rows: readonly PgRow[] = [
    {
      spreadsheet_id: "ss1",
      client_id: 1,
      title: "A",
      template_name: null,
      is_active: true,
    },
    {
      spreadsheet_id: "ss2",
      client_id: 2,
      title: "B",
      template_name: null,
      is_active: true,
    },
  ];
  expect(readSpreadsheetRows(rows, null).map((r) => r.server)).toStrictEqual([
    null,
    null,
  ]);
  expect(readSpreadsheetRows(rows, "sl-3").map((r) => r.server)).toStrictEqual([
    "sl-3",
    "sl-3",
  ]);
});

describe("readSpreadsheetRows: невалидный spreadsheet_id — PgRowError", () => {
  const cases: readonly (readonly [string, PgValue])[] = [
    ["пустая строка", ""],
    ["число вместо строки", 42],
    ["NULL", null],
  ];
  for (const [name, ssId] of cases) {
    it(name, () => {
      thrown(
        () =>
          readSpreadsheetRows(
            [
              {
                spreadsheet_id: ssId,
                client_id: 1,
                title: "t",
                template_name: null,
                is_active: true,
              },
            ],
            "sl-1",
          ),
        PgRowError,
        "spreadsheets.spreadsheet_id",
      );
    });
  }
});

it("readWbSidRows: orphan sid отбрасывается, сервер берётся у клиента", () => {
  const clients: readonly ClientRow[] = [
    { clientId: 1, server: "sl-1", isActive: 1, isLocked: 0, isDeleted: 0 },
    { clientId: 2, server: null, isActive: 1, isLocked: 0, isDeleted: 0 },
  ];
  const rows: readonly PgRow[] = [
    { client_id: 1, sid: "sid-a" },
    { client_id: 2, sid: "sid-b" },
    // Клиента с id=999 в выборке шага 1 нет — sid отбрасывается молча.
    { client_id: 999, sid: "sid-orphan" },
  ];
  expect(readWbSidRows(rows, clients)).toStrictEqual([
    { sid: "sid-a", clientId: 1, server: "sl-1" },
    { sid: "sid-b", clientId: 2, server: null },
  ]);
});

it("readWbSidRows: повторяющиеся (client_id, sid) не схлопываются", () => {
  const clients: readonly ClientRow[] = [
    { clientId: 1, server: "sl-1", isActive: 1, isLocked: 0, isDeleted: 0 },
  ];
  const rows: readonly PgRow[] = [
    { client_id: 1, sid: "sid-a" },
    { client_id: 1, sid: "sid-a" },
  ];
  // DISTINCT — дело PG-запроса (шаг 3 спеки); здесь строки просто отдаются
  // как пришли.
  expect(readWbSidRows(rows, clients)).toStrictEqual([
    { sid: "sid-a", clientId: 1, server: "sl-1" },
    { sid: "sid-a", clientId: 1, server: "sl-1" },
  ]);
});

it("writeSnapshot: записывает поля клиентов, таблиц и sid'ов вместе с synced_at", async () => {
  await withDb((db) => {
    const snapshot: Snapshot = {
      clients: [
        {
          clientId: 1,
          server: "sl-1",
          isActive: 1,
          isLocked: 0,
          isDeleted: 1,
        },
      ],
      spreadsheets: [
        {
          ssId: "ss1",
          clientId: 1,
          title: "Отчёт",
          templateName: "shop",
          isActive: 1,
          server: "sl-1",
        },
      ],
      wbSids: [{ sid: "sid-a", clientId: 1, server: "sl-1" }],
    };
    writeSnapshot(db, snapshot, 1000);

    expect(plainRows(db.query("SELECT * FROM sl_clients"))).toStrictEqual([
      {
        client_id: 1,
        server: "sl-1",
        is_active: 1,
        is_locked: 0,
        is_deleted: 1,
        synced_at: 1000,
      },
    ]);
    expect(plainRows(db.query("SELECT * FROM sl_spreadsheets"))).toStrictEqual([
      {
        ss_id: "ss1",
        client_id: 1,
        title: "Отчёт",
        template_name: "shop",
        is_active: 1,
        server: "sl-1",
        synced_at: 1000,
      },
    ]);
    expect(plainRows(db.query("SELECT * FROM sl_wb_sids"))).toStrictEqual([
      { sid: "sid-a", client_id: 1, server: "sl-1", synced_at: 1000 },
    ]);
  });
});

it("writeSnapshot: повторный прогон с другой выборкой полностью замещает прежний снапшот", async () => {
  await withDb((db) => {
    writeSnapshot(
      db,
      {
        clients: [
          {
            clientId: 1,
            server: "sl-1",
            isActive: 1,
            isLocked: 0,
            isDeleted: 0,
          },
          {
            clientId: 2,
            server: "sl-2",
            isActive: 1,
            isLocked: 0,
            isDeleted: 0,
          },
        ],
        spreadsheets: [
          {
            ssId: "ss1",
            clientId: 1,
            title: "A",
            templateName: null,
            isActive: 1,
            server: "sl-1",
          },
        ],
        wbSids: [{ sid: "sid-1", clientId: 1, server: "sl-1" }],
      },
      1000,
    );

    writeSnapshot(
      db,
      {
        clients: [
          {
            clientId: 3,
            server: "sl-3",
            isActive: 1,
            isLocked: 0,
            isDeleted: 0,
          },
        ],
        spreadsheets: [],
        wbSids: [],
      },
      2000,
    );

    // Ни одной строки прошлого прогона: клиенты 1 и 2, ss1 и sid-1 исчезли.
    expect(
      plainRows(db.query("SELECT client_id FROM sl_clients")),
    ).toStrictEqual([
      {
        client_id: 3,
      },
    ]);
    expect(
      plainRows(db.query("SELECT ss_id FROM sl_spreadsheets")),
    ).toStrictEqual([]);
    expect(plainRows(db.query("SELECT sid FROM sl_wb_sids"))).toStrictEqual([]);
  });
});

it("writeSnapshot: self-heal — пишет и на БД без таблиц снапшота", async () => {
  await withDb((db) => {
    // bootstrap намеренно не вызван — таблиц снапшота ещё нет.
    thrown(() => db.query("SELECT * FROM sl_clients"), Error, "no such table");

    writeSnapshot(
      db,
      {
        clients: [
          {
            clientId: 1,
            server: "sl-1",
            isActive: 1,
            isLocked: 0,
            isDeleted: 0,
          },
        ],
        spreadsheets: [],
        wbSids: [],
      },
      1000,
    );

    expect(
      plainRows(db.query("SELECT client_id FROM sl_clients")),
    ).toStrictEqual([
      {
        client_id: 1,
      },
    ]);
  });
});

it("upsertClient: обновляет своего клиента, соседнего не трогает", async () => {
  await withDb((db) => {
    writeSnapshot(
      db,
      {
        clients: [
          {
            clientId: 1,
            server: "sl-1",
            isActive: 1,
            isLocked: 0,
            isDeleted: 0,
          },
          {
            clientId: 2,
            server: "sl-2",
            isActive: 1,
            isLocked: 0,
            isDeleted: 0,
          },
        ],
        spreadsheets: [
          {
            ssId: "ss1",
            clientId: 1,
            title: "A",
            templateName: null,
            isActive: 1,
            server: "sl-1",
          },
          {
            ssId: "ss2",
            clientId: 2,
            title: "B",
            templateName: null,
            isActive: 1,
            server: "sl-2",
          },
        ],
        wbSids: [
          { sid: "sid-1", clientId: 1, server: "sl-1" },
          { sid: "sid-2", clientId: 2, server: "sl-2" },
        ],
      },
      1000,
    );

    upsertClient(
      db,
      {
        client: {
          clientId: 1,
          server: "sl-1",
          isActive: 0,
          isLocked: 1,
          isDeleted: 0,
        },
        spreadsheets: [
          {
            ssId: "ss1",
            clientId: 1,
            title: "A2",
            templateName: "t",
            isActive: 0,
            server: "sl-1",
          },
        ],
        wbSids: [{ sid: "sid-1b", clientId: 1, server: "sl-1" }],
      },
      2000,
    );

    expect(
      plainRows(
        db.query(
          "SELECT client_id, is_active, is_locked, synced_at FROM sl_clients ORDER BY client_id",
        ),
      ),
    ).toStrictEqual([
      { client_id: 1, is_active: 0, is_locked: 1, synced_at: 2000 },
      { client_id: 2, is_active: 1, is_locked: 0, synced_at: 1000 },
    ]);
    expect(
      plainRows(
        db.query(
          "SELECT ss_id, client_id, title, synced_at FROM sl_spreadsheets ORDER BY ss_id",
        ),
      ),
    ).toStrictEqual([
      { ss_id: "ss1", client_id: 1, title: "A2", synced_at: 2000 },
      { ss_id: "ss2", client_id: 2, title: "B", synced_at: 1000 },
    ]);
    expect(
      plainRows(
        db.query(
          "SELECT sid, client_id, synced_at FROM sl_wb_sids ORDER BY sid",
        ),
      ),
    ).toStrictEqual([
      { sid: "sid-1", client_id: 1, synced_at: 1000 },
      { sid: "sid-1b", client_id: 1, synced_at: 2000 },
      { sid: "sid-2", client_id: 2, synced_at: 1000 },
    ]);
  });
});

it("upsertClient: строки клиента, исчезнувшие из выборки, не удаляются", async () => {
  await withDb((db) => {
    writeSnapshot(
      db,
      {
        clients: [
          {
            clientId: 1,
            server: "sl-1",
            isActive: 1,
            isLocked: 0,
            isDeleted: 0,
          },
        ],
        spreadsheets: [
          {
            ssId: "ss1",
            clientId: 1,
            title: "A",
            templateName: null,
            isActive: 1,
            server: "sl-1",
          },
          {
            ssId: "ss-gone",
            clientId: 1,
            title: "Gone",
            templateName: null,
            isActive: 1,
            server: "sl-1",
          },
        ],
        wbSids: [
          { sid: "sid-1", clientId: 1, server: "sl-1" },
          { sid: "sid-gone", clientId: 1, server: "sl-1" },
        ],
      },
      1000,
    );

    // Новая выборка клиента 1 без ss-gone/sid-gone: upsert не чистит.
    upsertClient(
      db,
      {
        client: {
          clientId: 1,
          server: "sl-1",
          isActive: 1,
          isLocked: 0,
          isDeleted: 0,
        },
        spreadsheets: [
          {
            ssId: "ss1",
            clientId: 1,
            title: "A",
            templateName: null,
            isActive: 1,
            server: "sl-1",
          },
        ],
        wbSids: [{ sid: "sid-1", clientId: 1, server: "sl-1" }],
      },
      2000,
    );

    expect(
      plainRows(db.query("SELECT ss_id FROM sl_spreadsheets ORDER BY ss_id")),
    ).toStrictEqual([{ ss_id: "ss-gone" }, { ss_id: "ss1" }]);
    expect(
      plainRows(db.query("SELECT sid FROM sl_wb_sids ORDER BY sid")),
    ).toStrictEqual([{ sid: "sid-1" }, { sid: "sid-gone" }]);
  });
});

it("upsertClient: spreadsheets/wbSids = null — часть не выполнена, старые строки нетронуты", async () => {
  await withDb((db) => {
    writeSnapshot(
      db,
      {
        clients: [
          {
            clientId: 1,
            server: "sl-1",
            isActive: 1,
            isLocked: 0,
            isDeleted: 0,
          },
        ],
        spreadsheets: [
          {
            ssId: "ss1",
            clientId: 1,
            title: "A",
            templateName: null,
            isActive: 1,
            server: "sl-1",
          },
        ],
        wbSids: [{ sid: "sid-1", clientId: 1, server: "sl-1" }],
      },
      1000,
    );

    upsertClient(
      db,
      {
        client: {
          clientId: 1,
          server: "sl-1",
          isActive: 0,
          isLocked: 0,
          isDeleted: 0,
        },
        spreadsheets: null,
        wbSids: null,
      },
      2000,
    );

    expect(
      plainRows(
        db.query("SELECT is_active FROM sl_clients WHERE client_id = 1"),
      ),
    ).toStrictEqual([{ is_active: 0 }]);
    expect(
      plainRows(
        db.query(
          "SELECT ss_id, synced_at FROM sl_spreadsheets WHERE client_id = 1",
        ),
      ),
    ).toStrictEqual([{ ss_id: "ss1", synced_at: 1000 }]);
    expect(
      plainRows(
        db.query("SELECT sid, synced_at FROM sl_wb_sids WHERE client_id = 1"),
      ),
    ).toStrictEqual([{ sid: "sid-1", synced_at: 1000 }]);
  });
});
