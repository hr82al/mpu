/**
 * Ветка 10X `mpu search` целиком (`docs/specs/search.md`): email-ветка,
 * 10X-резолв не-email селектора, тёплый/холодный кэш, неоднозначность и
 * дотягивание owned-клиента вне снапшота. Прогон через `runSearch`
 * (`cmd_search.ts`) — тот же путь, что видит CLI, с подменённым
 * отправителем 10X (`X10Send`) и синками.
 *
 * Кэш-БД — настоящий SQLite во временном каталоге, как в
 * `cmd_search_test.ts`; сети нет ни на одном пути — `send` фейков
 * проверяет метод/путь/заголовки/тело и падает на лишнем или
 * неожиданном вызове.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { type CacheDb, DomainError } from "../command/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { localDate } from "../dates/mod.ts";
import {
  renderSearch,
  runSearch,
  type SearchArgs,
  searchCommand,
} from "./cmd_search.ts";
import type { X10Send } from "./x10_http.ts";

/** Базовый URL 10X эталонов этого файла: `x10BaseUrl` добавит `/api`. */
const X10_URL = "https://x10.test";
const BASE_API = "https://x10.test/api";

const X10_LOGIN = "staff@ops.example";
const X10_PASSWORD = "s3cr3t";

/** Кэш-БД во временном каталоге; клиенты — по явному списку таблиц. */
async function withCache(
  clients: readonly {
    readonly clientId: number;
    readonly tables: readonly [string, string][];
  }[],
  body: (db: CacheDb) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    for (const client of clients) {
      db.execute(
        "INSERT INTO sl_clients (client_id, server, is_active, is_locked," +
          " is_deleted, synced_at) VALUES (?, 'sl-9', 1, 0, 0, ?)",
        client.clientId,
        1_700_000_000,
      );
      for (const [ssId, title] of client.tables) {
        db.execute(
          "INSERT INTO sl_spreadsheets (ss_id, client_id, title, is_active," +
            " server, synced_at) VALUES (?, ?, ?, 1, 'sl-9', ?)",
          ssId,
          client.clientId,
          title,
          1_700_000_000,
        );
      }
    }
    await body(db);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Окружение вызова: staff-креды, адрес 10X, накопитель `progress`. */
function harness(
  db: CacheDb,
  envOverrides: Readonly<Record<string, string>> = {},
) {
  const env: Record<string, string> = {
    X10_LOGIN,
    X10_PASSWORD,
    X10_URL,
    ...envOverrides,
  };
  const progressLines: string[] = [];
  const io = makeFakeIo({
    env: (name) => name === "HOME" ? "/home/test" : undefined,
    envFile: {
      get: (name) => env[name],
      values: () => ({ ...env }),
      require: (name) => env[name] ?? "",
      set: () => Promise.reject(new Error("запись env-файла не ожидается")),
    },
    openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }),
    progress: (line) => {
      progressLines.push(line);
    },
  });
  return { io, progressLines };
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

/** Один ожидаемый вызов 10X: что проверяется и что фейк отвечает. */
interface Step {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly token?: string;
  readonly body?: unknown;
  readonly status?: number;
  readonly data?: unknown;
}

/**
 * Отправитель, идущий по заготовленному списку шагов по порядку. Вызов
 * сверх списка или не по шагу — падение теста тут же, а не молчаливый
 * неверный ответ (спека проверяется по наблюдаемой последовательности
 * HTTP-вызовов, а не только по итоговому результату).
 */
function sequentialSend(
  steps: readonly Step[],
): { send: X10Send; assertDone: () => void } {
  let i = 0;
  const send: X10Send = (url, init) => {
    if (i >= steps.length) {
      throw new Error(`лишний вызов 10X: ${init.method} ${url.toString()}`);
    }
    const step = steps[i];
    const label = `вызов #${i + 1}`;
    i++;
    assertEquals(init.method, step.method, `${label}: метод`);
    assertEquals(url.toString(), `${BASE_API}${step.path}`, `${label}: путь`);
    assertEquals(init.headers.accept, "application/json", `${label}: accept`);
    assertEquals(
      init.headers.authorization,
      step.token === undefined ? undefined : `Bearer ${step.token}`,
      `${label}: authorization`,
    );
    if (step.body !== undefined) {
      assertEquals(init.body, JSON.stringify(step.body), `${label}: тело`);
    }
    return Promise.resolve({
      status: step.status ?? 200,
      text: JSON.stringify({
        success: true,
        message: "OK",
        data: step.data ?? null,
      }),
    });
  };
  return {
    send,
    assertDone: () =>
      assertEquals(i, steps.length, "не все ожидаемые вызовы 10X случились"),
  };
}

/** Отправитель, падающий на любом вызове — используется на тёплом кэше. */
const failSend: X10Send = (url, init) => {
  throw new Error(`10X не должен вызываться: ${init.method} ${url.toString()}`);
};

/** Строка email-кэша как в `writeTarget` (`x10_branch.ts`), для тёплых сценариев. */
function insertEmailCache(
  db: CacheDb,
  row: {
    readonly email: string;
    readonly targetUserId: string;
    readonly targetName: string | null;
    readonly isEmailVerified: boolean;
    readonly ownedClientIds: readonly number[];
    readonly workspaces: readonly Readonly<Record<string, unknown>>[];
    readonly reason: string;
    readonly fetchedAt: number;
  },
): void {
  db.execute(
    "INSERT INTO x10_email_clients (email, target_user_id, target_name," +
      " is_email_verified, owned_client_ids, workspaces_json, reason," +
      " fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    row.email,
    row.targetUserId,
    row.targetName,
    row.isEmailVerified ? 1 : 0,
    JSON.stringify(row.ownedClientIds),
    JSON.stringify(row.workspaces),
    row.reason,
    row.fetchedAt,
  );
}

/* --------------------------------------------------------------- *
 * email-ветка: холодный кэш — полная последовательность вызовов
 * --------------------------------------------------------------- */

Deno.test("email-ветка, холодный кэш: login → staff-search → impersonate → workspaces", async () => {
  await withCache(
    [{
      clientId: 10,
      tables: [["SS_ALPHA_0001", "Пример Альфа"], [
        "SS_ALPHA_0002",
        "Альфа Ozon",
      ]],
    }],
    async (db) => {
      const { io, progressLines } = harness(db);
      const now = 1_700_000_000;
      const email = "target@example.com";
      const { send, assertDone } = sequentialSend([
        {
          method: "POST",
          path: "/auth/login",
          body: { email: X10_LOGIN, password: X10_PASSWORD },
          data: { access_token: "staff-tok" },
        },
        {
          method: "GET",
          path: `/users/staff/search?query=${encodeURIComponent(email)}`,
          token: "staff-tok",
          data: [{
            id: 555,
            email,
            name: "Alpha Target",
            isEmailVerified: true,
          }],
        },
        {
          method: "POST",
          path: "/auth/impersonate",
          token: "staff-tok",
          body: {
            targetUserId: 555,
            reason: `ТП ${
              localDate(now * 1000, new Date().getTimezoneOffset())
            }`,
          },
          data: { access_token: "imp-tok" },
        },
        {
          method: "GET",
          path: "/workspaces",
          token: "imp-tok",
          data: [
            { id: 10, ownerId: 555, name: "WS Ten", marketplace: "wb" },
            { id: 11, ownerId: 777, name: "WS Eleven", marketplace: "ozon" },
          ],
        },
      ]);
      const result = await runSearch(searchArgs({ value: email }), io, {
        send,
        nowSeconds: () => now,
      });
      assertDone();
      assertEquals(progressLines, []);
      const target = result.target;
      if (target === null) throw new Error("ожидалась цель, а не null");
      assertEquals(target.email, email);
      assertEquals(target.target_user_id, "555");
      assertEquals(target.owned.map((row) => row.client_id), [10, 10]);
      assertEquals(target.member_only, [{
        workspace_id: 11,
        name: "WS Eleven",
        marketplace: "ozon",
      }]);
      assertEquals(result.ambiguous, null);

      // Кэш заполнен: одна строка email→клиент, две сессии.
      assertEquals(
        db.query("SELECT COUNT(*) AS n FROM x10_email_clients")[0].n,
        1,
      );
      const sessions = db.query("SELECT kind FROM x10_sessions ORDER BY kind");
      assertEquals(sessions.map((row) => row.kind), ["impersonation", "staff"]);
    },
  );
});

/* --------------------------------------------------------------- *
 * Тёплый кэш и --refresh-cache
 * --------------------------------------------------------------- */

Deno.test("email-ветка, тёплый кэш: ни одного HTTP-вызова", async () => {
  await withCache(
    [{ clientId: 10, tables: [["SS_ALPHA_0001", "Пример Альфа"]] }],
    async (db) => {
      const email = "warm@example.com";
      insertEmailCache(db, {
        email,
        targetUserId: "555",
        targetName: "Warm Target",
        isEmailVerified: true,
        ownedClientIds: [10],
        workspaces: [{
          id: 10,
          ownerId: 555,
          name: "WS Ten",
          marketplace: "wb",
        }],
        reason: "ТП 2026-08-01",
        fetchedAt: 1_699_000_000,
      });
      const { io } = harness(db);
      const result = await runSearch(searchArgs({ value: email }), io, {
        send: failSend,
        nowSeconds: () => 1_700_000_000,
      });
      const target = result.target;
      if (target === null) throw new Error("ожидалась цель, а не null");
      assertEquals(target.email, email);
      assertEquals(target.target_user_id, "555");
      assertEquals(target.owned.map((row) => row.client_id), [10]);
    },
  );
});

Deno.test("--refresh-cache: тёплый email-кэш игнорируется, запросы идут снова", async () => {
  await withCache(
    [{ clientId: 10, tables: [["SS_ALPHA_0001", "Пример Альфа"]] }],
    async (db) => {
      const email = "refresh@example.com";
      insertEmailCache(db, {
        email,
        targetUserId: "555",
        targetName: "Stale Target",
        isEmailVerified: true,
        ownedClientIds: [10],
        workspaces: [{
          id: 10,
          ownerId: 555,
          name: "WS Ten",
          marketplace: "wb",
        }],
        reason: "ТП 2026-08-01",
        fetchedAt: 1_699_000_000,
      });
      const { io } = harness(db);
      const now = 1_700_000_000;
      const { send, assertDone } = sequentialSend([
        {
          method: "POST",
          path: "/auth/login",
          body: { email: X10_LOGIN, password: X10_PASSWORD },
          data: { access_token: "staff-tok-2" },
        },
        {
          method: "GET",
          path: `/users/staff/search?query=${encodeURIComponent(email)}`,
          token: "staff-tok-2",
          data: [{
            id: 555,
            email,
            name: "Fresh Target",
            isEmailVerified: true,
          }],
        },
        {
          method: "POST",
          path: "/auth/impersonate",
          token: "staff-tok-2",
          body: {
            targetUserId: 555,
            reason: `ТП ${
              localDate(now * 1000, new Date().getTimezoneOffset())
            }`,
          },
          data: { access_token: "imp-tok-2" },
        },
        {
          method: "GET",
          path: "/workspaces",
          token: "imp-tok-2",
          data: [{
            id: 10,
            ownerId: 555,
            name: "WS Ten Fresh",
            marketplace: "wb",
          }],
        },
      ]);
      const result = await runSearch(
        searchArgs({ value: email, "refresh-cache": true }),
        io,
        { send, nowSeconds: () => now },
      );
      assertDone();
      const target = result.target;
      if (target === null) throw new Error("ожидалась цель, а не null");
      assertEquals(target.target_name, "Fresh Target");
    },
  );
});

/* --------------------------------------------------------------- *
 * Неоднозначность (10X-резолв не-email селектора, scope=access)
 * --------------------------------------------------------------- */

Deno.test("неоднозначность: сессия impersonation не создаётся, кандидаты в stdout, exit 2", async () => {
  await withCache([], async (db) => {
    const { io, progressLines } = harness(db);
    const staffSearchBody = await Deno.readTextFile(
      new URL("./testdata/staff-search-access.json", import.meta.url),
    );
    const { send, assertDone } = sequentialSend([
      {
        method: "POST",
        path: "/auth/login",
        body: { email: X10_LOGIN, password: X10_PASSWORD },
        data: { access_token: "staff-tok-3" },
      },
    ]);
    // Второй вызов (staff-search) отвечает голденом канала как есть —
    // ответ там уже обёрнут в {success, message, data}.
    let calls = 0;
    const sendWithGolden: X10Send = (url, init) => {
      if (calls === 0) {
        calls++;
        return send(url, init);
      }
      calls++;
      assertEquals(init.method, "GET");
      assertEquals(
        url.toString(),
        `${BASE_API}/users/staff/search?query=9001&scope=access`,
      );
      assertEquals(init.headers.authorization, "Bearer staff-tok-3");
      return Promise.resolve({ status: 200, text: staffSearchBody });
    };
    const result = await runSearch(
      searchArgs({ value: "9001", scope: "access" }),
      io,
      { send: sendWithGolden, nowSeconds: () => 1_700_000_000 },
    );
    assertDone();
    assertEquals(calls, 2);
    assertEquals(result.target, null);
    assertEquals(result.ambiguous, [
      {
        user_id: 1001,
        email: "user@example.com",
        name: "Иван Иванов",
        match: {
          via: "workspace",
          role: "admin",
          workspaceId: 2002,
          workspaceName: "ООО Ромашка",
          sid: "00000000-0000-4000-8000-000000000001",
          cabinetName: "Кабинет WB",
        },
      },
      {
        user_id: 1002,
        email: "second@example.com",
        name: "Пётр Петров",
        match: {
          via: "workspace",
          role: "member",
          workspaceId: 2002,
          workspaceName: "ООО Ромашка",
        },
      },
    ]);
    assertEquals(searchCommand.textExitCode(result), 2);
    assertEquals(
      renderSearch(result),
      `${JSON.stringify(result.ambiguous, null, 2)}\n`,
    );
    assertEquals(
      db.query(
        "SELECT COUNT(*) AS n FROM x10_sessions WHERE kind = 'impersonation'",
      )[0].n,
      0,
    );
    assertEquals(progressLines.length, 1);
    assertEquals(
      progressLines[0],
      "mpu search: 10X staff search (scope=access): по '9001' найдено кандидатов: 2;" +
        " повтори с точным email или с user.id (--scope user)",
    );
  });
});

/* --------------------------------------------------------------- *
 * Точный email: отсутствует либо дублируется
 * --------------------------------------------------------------- */

Deno.test("точного email нет — отказ с числом substring-совпадений", async () => {
  await withCache([], async (db) => {
    const { io } = harness(db);
    const email = "ghost@example.com";
    const { send } = sequentialSend([
      {
        method: "POST",
        path: "/auth/login",
        body: { email: X10_LOGIN, password: X10_PASSWORD },
        data: { access_token: "tok" },
      },
      {
        method: "GET",
        path: `/users/staff/search?query=${encodeURIComponent(email)}`,
        token: "tok",
        data: [
          {
            id: 1,
            email: "someone@example.com",
            name: null,
            isEmailVerified: false,
          },
          {
            id: 2,
            email: "other@example.com",
            name: null,
            isEmailVerified: false,
          },
        ],
      },
    ]);
    const err = await assertRejects(
      () =>
        runSearch(searchArgs({ value: email }), io, {
          send,
          nowSeconds: () => 1_700_000_000,
        }),
      DomainError,
    );
    assertEquals(
      err.message,
      "10X staff search: нет пользователя с точным email 'ghost@example.com'" +
        " (по substring найдено 2); проверь адрес или что это не staff-аккаунт",
    );
  });
});

Deno.test("больше одного email — отказ со списком id", async () => {
  await withCache([], async (db) => {
    const { io } = harness(db);
    const email = "dup@example.com";
    const { send } = sequentialSend([
      {
        method: "POST",
        path: "/auth/login",
        body: { email: X10_LOGIN, password: X10_PASSWORD },
        data: { access_token: "tok" },
      },
      {
        method: "GET",
        path: `/users/staff/search?query=${encodeURIComponent(email)}`,
        token: "tok",
        data: [
          { id: 11, email, name: null, isEmailVerified: false },
          { id: 12, email, name: null, isEmailVerified: false },
        ],
      },
    ]);
    const err = await assertRejects(
      () =>
        runSearch(searchArgs({ value: email }), io, {
          send,
          nowSeconds: () => 1_700_000_000,
        }),
      DomainError,
    );
    assertEquals(
      err.message,
      "10X staff search: несколько юзеров с email 'dup@example.com': ids=[11, 12]",
    );
  });
});

/* --------------------------------------------------------------- *
 * --reason: дефолт «ТП <дата>» и явное значение
 * --------------------------------------------------------------- */

Deno.test("--reason по умолчанию — «ТП <дата>» от подставленного nowSeconds", async () => {
  await withCache([], async (db) => {
    const { io } = harness(db);
    const now = 1_700_050_000;
    const expectedReason = `ТП ${
      localDate(now * 1000, new Date().getTimezoneOffset())
    }`;
    const email = "reason-default@example.com";
    const { send, assertDone } = sequentialSend([
      {
        method: "POST",
        path: "/auth/login",
        body: { email: X10_LOGIN, password: X10_PASSWORD },
        data: { access_token: "tok" },
      },
      {
        method: "GET",
        path: `/users/staff/search?query=${encodeURIComponent(email)}`,
        token: "tok",
        data: [{ id: 1, email, name: null, isEmailVerified: false }],
      },
      {
        method: "POST",
        path: "/auth/impersonate",
        token: "tok",
        body: { targetUserId: 1, reason: expectedReason },
        data: { access_token: "imp-tok" },
      },
      { method: "GET", path: "/workspaces", token: "imp-tok", data: [] },
    ]);
    const result = await runSearch(searchArgs({ value: email }), io, {
      send,
      nowSeconds: () => now,
    });
    assertDone();
    assertEquals(result.target?.reason, expectedReason);
  });
});

Deno.test("--reason задан — уходит в тело impersonate и в вывод", async () => {
  await withCache([], async (db) => {
    const { io } = harness(db);
    const email = "reason-custom@example.com";
    const { send, assertDone } = sequentialSend([
      {
        method: "POST",
        path: "/auth/login",
        body: { email: X10_LOGIN, password: X10_PASSWORD },
        data: { access_token: "tok" },
      },
      {
        method: "GET",
        path: `/users/staff/search?query=${encodeURIComponent(email)}`,
        token: "tok",
        data: [{ id: 1, email, name: null, isEmailVerified: false }],
      },
      {
        method: "POST",
        path: "/auth/impersonate",
        token: "tok",
        body: { targetUserId: 1, reason: "Причина ТП-42" },
        data: { access_token: "imp-tok" },
      },
      { method: "GET", path: "/workspaces", token: "imp-tok", data: [] },
    ]);
    const result = await runSearch(
      searchArgs({ value: email, reason: "Причина ТП-42" }),
      io,
      { send, nowSeconds: () => 1_700_000_000 },
    );
    assertDone();
    assertEquals(result.target?.reason, "Причина ТП-42");
  });
});

/* --------------------------------------------------------------- *
 * Креды отсутствуют, 401 под staff-токеном
 * --------------------------------------------------------------- */

Deno.test("нет X10_LOGIN/X10_PASSWORD — отказ и ни одного запроса", async () => {
  await withCache([], async (db) => {
    const { io } = harness(db, { X10_LOGIN: "", X10_PASSWORD: "" });
    const err = await assertRejects(
      () =>
        runSearch(searchArgs({ value: "target@example.com" }), io, {
          send: failSend,
          nowSeconds: () => 1_700_000_000,
        }),
      DomainError,
    );
    assertEquals(
      err.message,
      "10X credentials missing: X10_LOGIN. Add to /home/test/.config/mpu/.env or export in shell.",
    );
  });
});

Deno.test("401 под staff-токеном — суффикс про 10X staff-креды", async () => {
  await withCache([], async (db) => {
    const { io } = harness(db);
    const { send } = sequentialSend([
      {
        method: "POST",
        path: "/auth/login",
        body: { email: X10_LOGIN, password: X10_PASSWORD },
        status: 401,
      },
    ]);
    const err = await assertRejects(
      () =>
        runSearch(searchArgs({ value: "target@example.com" }), io, {
          send,
          nowSeconds: () => 1_700_000_000,
        }),
      DomainError,
    );
    assertEquals(
      err.message,
      "POST /auth/login: HTTP 401 (нужны 10X staff-креды X10_LOGIN/X10_PASSWORD," +
        " не sl-back TOKEN_*)",
    );
  });
});

/* --------------------------------------------------------------- *
 * Owned-клиент вне локального снапшота
 * --------------------------------------------------------------- */

Deno.test("owned-клиент вне снапшота: точечный синк раз, затем warning и голая строка", async () => {
  await withCache([], async (db) => {
    const { io, progressLines } = harness(db);
    const email = "orphan@example.com";
    const { send, assertDone } = sequentialSend([
      {
        method: "POST",
        path: "/auth/login",
        body: { email: X10_LOGIN, password: X10_PASSWORD },
        data: { access_token: "tok" },
      },
      {
        method: "GET",
        path: `/users/staff/search?query=${encodeURIComponent(email)}`,
        token: "tok",
        data: [{ id: 42, email, name: null, isEmailVerified: false }],
      },
      {
        method: "POST",
        path: "/auth/impersonate",
        token: "tok",
        body: {
          targetUserId: 42,
          reason: `ТП ${
            localDate(1_700_000_000_000, new Date().getTimezoneOffset())
          }`,
        },
        data: { access_token: "imp-tok" },
      },
      {
        method: "GET",
        path: "/workspaces",
        token: "imp-tok",
        data: [{ id: 999, ownerId: 42, name: "WS Orphan", marketplace: "wb" }],
      },
    ]);
    let syncClientCalls = 0;
    const result = await runSearch(searchArgs({ value: email }), io, {
      send,
      nowSeconds: () => 1_700_000_000,
      syncClient: (_syncIo, clientId) => {
        syncClientCalls++;
        assertEquals(clientId, 999);
        return Promise.resolve();
      },
    });
    assertDone();
    assertEquals(syncClientCalls, 1);
    assertEquals(result.rows, [
      {
        client_id: 999,
        spreadsheet_id: null,
        title: null,
        server: null,
        server_number: null,
        sl_ip: null,
        pg_ip: null,
        sids: [],
      },
    ]);
    assertEquals(progressLines, [
      "warning: client 999 не найден в реестре (показан без таблицы)",
    ]);
    assertEquals(searchCommand.textExitCode(result), 0);
  });
});
