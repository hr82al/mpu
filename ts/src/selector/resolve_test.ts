/**
 * Контрактные тесты платформенного резолва селектора
 * (`docs/specs/platform/selector.md`): порядок разбора, порядок
 * предикатов, вердикт по множеству серверов, вторая ступень и печать
 * кандидатов. Кэш — синтетический: временный файл SQLite через
 * `openCacheDb` (как в `../update/cache_test.ts`), заполняется прямо в
 * тесте. Сети нет ни на одном пути.
 *
 * Тексты ошибок, снятые с живой версии, сверяются с копиями golden
 * (`testdata/`, сверка копий с каналом — `fixtures_test.ts`): префикс
 * команды в фикстуре — `mpu sql-ro:`, его подставляет тест через
 * `formatCommandError`, потому что сама команда ещё не перенесена.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { openCacheDb } from "../store/mod.ts";
import { type CacheDb, formatCommandError } from "../command/mod.ts";
import {
  type CacheReader,
  type Candidate,
  formatCandidates,
  requireSingleClient,
  type Resolved,
  resolveSelector,
  SelectorError,
  type SelectorSources,
  type ServerAddresses,
} from "./mod.ts";

/** Содержимое синтетического кэша: только то, что читает резолв. */
interface Cache {
  readonly clients?: readonly { id: number; server: string | null }[];
  readonly spreadsheets?: readonly {
    ssId: string;
    clientId: number;
    title: string;
    server: string | null;
  }[];
  readonly sids?: readonly { sid: string; clientId: number }[];
  readonly emails?: readonly { email: string; owned: string }[];
}

function fill(db: CacheDb, cache: Cache): void {
  db.bootstrap();
  for (const client of cache.clients ?? []) {
    db.execute(
      "INSERT INTO sl_clients (client_id, server, is_active, is_locked," +
        " is_deleted, synced_at) VALUES (?, ?, 1, 0, 0, 0)",
      client.id,
      client.server,
    );
  }
  for (const sheet of cache.spreadsheets ?? []) {
    db.execute(
      "INSERT INTO sl_spreadsheets (ss_id, client_id, title, template_name," +
        " is_active, server, synced_at) VALUES (?, ?, ?, NULL, 1, ?, 0)",
      sheet.ssId,
      sheet.clientId,
      sheet.title,
      sheet.server,
    );
  }
  for (const sid of cache.sids ?? []) {
    db.execute(
      "INSERT INTO sl_wb_sids (sid, client_id, server, synced_at)" +
        " VALUES (?, ?, NULL, 0)",
      sid.sid,
      sid.clientId,
    );
  }
  for (const row of cache.emails ?? []) {
    db.execute(
      "INSERT INTO x10_email_clients (email, target_user_id, target_name," +
        " is_email_verified, owned_client_ids, workspaces_json, reason," +
        " fetched_at) VALUES (?, 'u-1', NULL, 1, ?, '[]', 'тест', 0)",
      row.email,
      row.owned,
    );
  }
}

/**
 * Временная кэш-БД с уборкой. `bootstrap` вызывает `fill`, поэтому тест
 * неинициализированной БД просто не заполняет её (`cache` не передан).
 */
async function withCache(
  cache: Cache | undefined,
  body: (sources: SelectorSources, db: CacheDb) => void | Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    if (cache !== undefined) fill(db, cache);
    await body({ cache: db, env: envOf({}) }, db);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function envOf(values: Readonly<Record<string, string>>): ServerAddresses {
  return { values: () => ({ ...values }) };
}

/** Источники, к которым обращаться нельзя: короткий цикл их не трогает. */
const untouchable: SelectorSources = {
  cache: {
    query: () => {
      throw new Error("кэш-БД читаться не должна");
    },
  },
  env: {
    values: () => {
      throw new Error("env-файл читаться не должен");
    },
  },
};

/** Кэш из одного клиента с двумя таблицами и двумя sid'ами на sl-1. */
const ONE_CLIENT: Cache = {
  clients: [{ id: 7, server: "sl-1" }],
  spreadsheets: [
    { ssId: "ss-alpha", clientId: 7, title: "Отчёт alpha", server: "sl-1" },
    { ssId: "ss-beta", clientId: 7, title: "", server: "sl-1" },
  ],
  sids: [{ sid: "wb-b", clientId: 7 }, { sid: "wb-a", clientId: 7 }],
};

function golden(name: string): string {
  return Deno.readTextFileSync(
    new URL(`testdata/${name}`, import.meta.url),
  ).trimEnd();
}

function messageOf(fn: () => unknown): string {
  const err = assertThrows(fn, SelectorError);
  return (err as SelectorError).message;
}

function candidatesOf(fn: () => unknown): readonly Candidate[] {
  const err = assertThrows(fn, SelectorError);
  return (err as SelectorError).candidates;
}

Deno.test("override --server: замещает value, кэш не читается", () => {
  assertEquals(resolveSelector(untouchable, "7", { server: "sl-4" }), {
    selector: "7",
    serverNumber: 4,
    candidates: [],
  });
});

Deno.test("override --server: невалидное значение — дословный текст", () => {
  const err = assertThrows(
    () => resolveSelector(untouchable, "7", { server: "foo" }),
    SelectorError,
  );
  assertEquals(err.message, "bad --server: 'foo' (expected sl-N)");
  assertEquals(
    formatCommandError(["sql-ro"], err),
    golden("err-bad-server.txt"),
  );
});

Deno.test("sl-N: короткий цикл строго приоритетнее поиска по кэшу", async () => {
  // В кэше есть таблица с подстрокой `sl-1` в заголовке — короткий цикл
  // не даёт ей ни единого шанса: кэш не читается вовсе (инвариант спеки).
  await withCache({
    clients: [{ id: 3, server: "sl-9" }],
    spreadsheets: [
      { ssId: "ss-1", clientId: 3, title: "стенд sl-1", server: "sl-9" },
    ],
  }, () => {
    assertEquals(resolveSelector(untouchable, "sl-1"), {
      selector: "sl-1",
      serverNumber: 1,
      candidates: [],
    });
  });
  // sl-0 — обычный сервер, особых веток нет.
  assertEquals(resolveSelector(untouchable, "sl-0").serverNumber, 0);
});

Deno.test("client_id: кандидат на таблицу клиента, sid'ы по возрастанию", async () => {
  await withCache(ONE_CLIENT, (sources) => {
    assertEquals(resolveSelector(sources, "7"), {
      selector: "7",
      serverNumber: 1,
      candidates: [
        {
          clientId: 7,
          spreadsheetId: "ss-alpha",
          title: "Отчёт alpha",
          server: "sl-1",
          serverNumber: 1,
          sids: ["wb-a", "wb-b"],
        },
        {
          clientId: 7,
          spreadsheetId: "ss-beta",
          title: "",
          server: "sl-1",
          serverNumber: 1,
          sids: ["wb-a", "wb-b"],
        },
      ],
    });
  });
});

Deno.test("client_id: клиент без таблиц — одна строка с null-полями", async () => {
  await withCache({ clients: [{ id: 8, server: "sl-2" }] }, (sources) => {
    assertEquals(resolveSelector(sources, "8").candidates, [
      {
        clientId: 8,
        spreadsheetId: null,
        title: null,
        server: "sl-2",
        serverNumber: 2,
        sids: [],
      },
    ]);
  });
});

Deno.test("порядок предикатов: sid раньше spreadsheet_id", async () => {
  // Значение матчит и sid клиента 7, и подстроку ss_id клиента 9.
  await withCache({
    clients: [{ id: 7, server: "sl-1" }, { id: 9, server: "sl-2" }],
    spreadsheets: [
      { ssId: "ss-7", clientId: 7, title: "клиент 7", server: "sl-1" },
      { ssId: "ss-wb-a-9", clientId: 9, title: "клиент 9", server: "sl-2" },
    ],
    sids: [{ sid: "wb-a", clientId: 7 }],
  }, (sources) => {
    const resolved = resolveSelector(sources, "wb-a");
    assertEquals(resolved.serverNumber, 1);
    assertEquals(resolved.candidates.map((c) => c.clientId), [7]);
  });
});

Deno.test("порядок предикатов: sid точный раньше подстроки", async () => {
  await withCache({
    clients: [{ id: 7, server: "sl-1" }, { id: 9, server: "sl-2" }],
    sids: [{ sid: "wb-a", clientId: 9 }, { sid: "wb-a-long", clientId: 7 }],
  }, (sources) => {
    // `wb-a` — точный sid клиента 9 и подстрока sid'а клиента 7:
    // побеждает точный, подстрочный поиск не выполняется.
    assertEquals(
      resolveSelector(sources, "wb-a").candidates.map((c) => c.clientId),
      [9],
    );
  });
});

Deno.test("порядок предикатов: title только при пустом spreadsheet_id", async () => {
  await withCache({
    clients: [{ id: 7, server: "sl-1" }, { id: 9, server: "sl-1" }],
    spreadsheets: [
      { ssId: "ss-alpha", clientId: 7, title: "первый", server: "sl-1" },
      { ssId: "ss-9", clientId: 9, title: "отчёт alpha", server: "sl-1" },
    ],
  }, (sources) => {
    // `alpha` есть и в ss_id клиента 7, и в заголовке клиента 9.
    assertEquals(
      resolveSelector(sources, "alpha").candidates.map((c) => c.clientId),
      [7],
    );
    // По заголовку ищем, только когда по ss_id пусто.
    assertEquals(
      resolveSelector(sources, "отчёт").candidates.map((c) => c.clientId),
      [9],
    );
  });
});

Deno.test("email: клиенты из кэша email→клиент, регистр не важен", async () => {
  await withCache({
    ...ONE_CLIENT,
    emails: [{ email: "client@example.com", owned: "[7]" }],
  }, (sources) => {
    assertEquals(
      resolveSelector(sources, "Client@Example.com").candidates.map((c) =>
        c.clientId
      ),
      [7, 7],
    );
  });
});

Deno.test("email вне кэша: подсказка запустить поиск, дословно", async () => {
  await withCache(ONE_CLIENT, (sources) => {
    const err = assertThrows(
      () => resolveSelector(sources, "nosuch@example.com"),
      SelectorError,
    );
    assertEquals(
      err.message,
      "email 'nosuch@example.com' не в кэше; " +
        "сначала запусти: mpu search nosuch@example.com",
    );
    assertEquals(err.candidates, []);
    assertEquals(
      formatCommandError(["sql-ro"], err),
      golden("err-email-not-cached.txt"),
    );
  });
});

Deno.test("email: нечитаемая строка кэша равнозначна её отсутствию", async (t) => {
  // Решение записано в `.tmp/spec-request-selector.md`, п. 7: своей
  // ошибки «кэш повреждён» у резолва нет, а подсказка «запусти mpu
  // search» и есть способ строку перезаписать.
  const cases: readonly (readonly [string, string])[] = [
    ["значение не JSON", "'не json'"],
    ["JSON не массив", "'{\"client_id\": 7}'"],
    ["значение не текст", "x'00'"],
  ];
  for (const [name, literal] of cases) {
    await t.step(name, async () => {
      await withCache(ONE_CLIENT, (sources, db) => {
        db.execute(
          "INSERT INTO x10_email_clients (email, target_user_id," +
            " target_name, is_email_verified, owned_client_ids," +
            " workspaces_json, reason, fetched_at)" +
            ` VALUES ('client@example.com', 'u-1', NULL, 1, ${literal},` +
            " '[]', 'тест', 0)",
        );
        assertEquals(
          messageOf(() => resolveSelector(sources, "client@example.com")),
          "email 'client@example.com' не в кэше; " +
            "сначала запусти: mpu search client@example.com",
        );
      });
    });
  }
});

Deno.test("испорченный кэш: столбец не того типа — ошибка с его именем", async (t) => {
  // Столбцы объявлены схемой как NOT NULL, но SQLite хранит в них что
  // угодно: такой файл БД испорчен, и резолв обязан сказать это внятно,
  // а не подставить пустое значение и выдать чушь за кандидата.
  await t.step("не целое в client_id", async () => {
    await withCache(ONE_CLIENT, (sources, db) => {
      db.execute(
        "INSERT INTO sl_spreadsheets (ss_id, client_id, title," +
          " template_name, is_active, server, synced_at)" +
          " VALUES ('ss-broken', 'не число', 'битая', NULL, 1, 'sl-1', 0)",
      );
      assertThrows(
        () => resolveSelector(sources, "ss-broken"),
        TypeError,
        "client_id: в кэш-БД не целое число",
      );
    });
  });
  await t.step("не текст в sid", async () => {
    await withCache(ONE_CLIENT, (sources, db) => {
      db.execute(
        "INSERT INTO sl_wb_sids (sid, client_id, server, synced_at)" +
          " VALUES (x'00', 7, NULL, 0)",
      );
      assertThrows(
        () => resolveSelector(sources, "7"),
        TypeError,
        "sl_wb_sids.sid: в кэш-БД не текст",
      );
    });
  });
});

Deno.test("IP: номер сервера из env-файла, кандидат без клиента", async () => {
  await withCache(ONE_CLIENT, (sources) => {
    const env = envOf({
      sl_1: "10.0.0.1",
      pg_3: "10.0.1.3",
      sl_3: "10.0.0.3",
      sl_3_portainer: "10.0.0.3:9000",
    });
    assertEquals(resolveSelector({ ...sources, env }, "10.0.1.3"), {
      selector: "10.0.1.3",
      serverNumber: 3,
      candidates: [
        {
          clientId: null,
          spreadsheetId: null,
          title: null,
          server: "sl-3",
          serverNumber: 3,
          sids: [],
        },
      ],
    });
  });
});

Deno.test("IP: неизвестный адрес — nothing matched, дословно", async () => {
  await withCache(ONE_CLIENT, (sources) => {
    const env = envOf({ sl_1: "10.0.0.1" });
    assertEquals(
      messageOf(() => resolveSelector({ ...sources, env }, "10.9.9.9")),
      "nothing matched: '10.9.9.9'",
    );
  });
});

Deno.test("IP: один адрес у разных серверов — ошибка конфигурации", async () => {
  await withCache(ONE_CLIENT, (sources) => {
    const env = envOf({ sl_1: "10.0.0.9", pg_4: "10.0.0.9", pg_1: "10.0.0.9" });
    assertEquals(
      messageOf(() => resolveSelector({ ...sources, env }, "10.0.0.9")),
      "конфликт адресов в env-файле: '10.0.0.9' задан ключами " +
        "pg_1, pg_4, sl_1",
    );
  });
});

Deno.test("вердикт: ничего не найдено — дословный текст golden", async () => {
  await withCache(ONE_CLIENT, (sources) => {
    const err = assertThrows(
      () => resolveSelector(sources, "zzz-no-such-thing"),
      SelectorError,
    );
    assertEquals(err.message, "nothing matched: 'zzz-no-such-thing'");
    assertEquals(
      formatCommandError(["sql-ro"], err),
      golden("err-nothing-matched.txt"),
    );
  });
});

Deno.test("вердикт: клиент найден, но сервера нет", async () => {
  await withCache({ clients: [{ id: 9, server: null }] }, (sources) => {
    const err = assertThrows(
      () => resolveSelector(sources, "9"),
      SelectorError,
    );
    assertEquals(err.message, "matched but no server resolvable: '9'");
    assertEquals(err.candidates.map((c) => c.clientId), [9]);
  });
});

Deno.test("вердикт: клиент на двух серверах — ambiguous", async () => {
  await withCache({
    clients: [{ id: 5, server: "sl-1" }],
    spreadsheets: [
      { ssId: "ss-1", clientId: 5, title: "а", server: "sl-1" },
      { ssId: "ss-2", clientId: 5, title: "б", server: "sl-1" },
      { ssId: "ss-3", clientId: 5, title: "в", server: "sl-2" },
    ],
  }, (sources) => {
    // Кандидатов три, серверов два: число в тексте — число кандидатов,
    // то есть длина печатаемого следом списка.
    assertEquals(
      messageOf(() => resolveSelector(sources, "5")),
      "ambiguous selector '5' — 3 candidates on different servers",
    );
    assertEquals(
      candidatesOf(() => resolveSelector(sources, "5")).map((c) =>
        c.spreadsheetId
      ),
      ["ss-1", "ss-2", "ss-3"],
    );
  });
});

Deno.test("вердикт: кандидат без сервера в множестве не участвует", async () => {
  // preserve-отклонение спеки: 2 кандидата на sl-1 + 1 без сервера —
  // однозначный успех со всеми тремя в выдаче. Достижимо в ветке
  // заголовка: там кандидаты приходят от разных клиентов, а сервер
  // таблицы сервером её клиента (sl-9) не замещается.
  await withCache({
    clients: [{ id: 5, server: "sl-1" }, { id: 6, server: "sl-9" }],
    spreadsheets: [
      { ssId: "ss-1", clientId: 5, title: "общий отчёт", server: "sl-1" },
      { ssId: "ss-2", clientId: 5, title: "общий отчёт", server: "sl-1" },
      { ssId: "ss-3", clientId: 6, title: "общий отчёт", server: null },
    ],
  }, (sources) => {
    const resolved = resolveSelector(sources, "общий");
    assertEquals(resolved.serverNumber, 1);
    assertEquals(resolved.candidates.map((c) => c.spreadsheetId), [
      "ss-1",
      "ss-2",
      "ss-3",
    ]);
    assertEquals(resolved.candidates.map((c) => c.server), [
      "sl-1",
      "sl-1",
      null,
    ]);
  });
});

Deno.test("сервер кандидата: пустой у таблицы замещается сервером клиента", async () => {
  // Замещение — только в ветках клиента (email, client_id, sid).
  const cache: Cache = {
    clients: [{ id: 4, server: "sl-2" }],
    spreadsheets: [
      { ssId: "ss-4", clientId: 4, title: "без сервера", server: null },
    ],
    sids: [{ sid: "wb-4", clientId: 4 }],
  };
  await withCache(cache, (sources) => {
    for (const value of ["4", "wb-4"]) {
      const resolved = resolveSelector(sources, value);
      assertEquals(resolved.serverNumber, 2, `селектор: ${value}`);
      assertEquals(resolved.candidates.map((c) => c.server), ["sl-2"]);
    }
  });
  await withCache(cache, (sources) => {
    // А в ветках поиска по таблице подстановки нет: сервера у таблицы
    // нет — значит его не вывести, и это matched but no server resolvable.
    assertEquals(
      messageOf(() => resolveSelector(sources, "ss-4")),
      "matched but no server resolvable: 'ss-4'",
    );
    assertEquals(
      messageOf(() => resolveSelector(sources, "без сервера")),
      "matched but no server resolvable: 'без сервера'",
    );
  });
});

Deno.test("подстрочный поиск: шаблоны LIKE и регистр — контракт спеки", async (t) => {
  await withCache({
    clients: [{ id: 5, server: "sl-1" }],
    spreadsheets: [
      { ssId: "ss-abc", clientId: 5, title: "Отчёт ALPHA", server: "sl-1" },
    ],
  }, async (sources) => {
    const found = (value: string) =>
      resolveSelector(sources, value).candidates.map((c) => c.spreadsheetId);
    await t.step("% в значении — шаблон, а не литерал", () => {
      assertEquals(found("ss%bc"), ["ss-abc"]);
    });
    await t.step("_ в значении — любой один символ", () => {
      assertEquals(found("ss_abc"), ["ss-abc"]);
    });
    await t.step("регистр ASCII не учитывается", () => {
      assertEquals(found("alpha"), ["ss-abc"]);
    });
    await t.step("регистр кириллицы учитывается", () => {
      assertEquals(
        messageOf(() => resolveSelector(sources, "отчёт")),
        "nothing matched: 'отчёт'",
      );
    });
  });
});

Deno.test("порядок кандидатов: ветка таблицы — по spreadsheet_id", async () => {
  await withCache({
    clients: [{ id: 5, server: "sl-1" }, { id: 6, server: "sl-1" }],
    spreadsheets: [
      { ssId: "ss-b", clientId: 5, title: "первая", server: "sl-1" },
      { ssId: "ss-a", clientId: 6, title: "вторая", server: "sl-1" },
    ],
  }, (sources) => {
    // Не по клиенту: таблица клиента 6 идёт первой, потому что её
    // spreadsheet_id меньше.
    assertEquals(
      resolveSelector(sources, "ss-").candidates.map((c) => c.spreadsheetId),
      ["ss-a", "ss-b"],
    );
  });
});

Deno.test("порядок кандидатов: ветка заголовка — по заголовку, затем по таблице", async () => {
  await withCache({
    clients: [{ id: 5, server: "sl-1" }],
    spreadsheets: [
      { ssId: "ss-b", clientId: 5, title: "яблоко отчёт", server: "sl-1" },
      { ssId: "ss-a", clientId: 5, title: "яблоко отчёт", server: "sl-1" },
      { ssId: "ss-c", clientId: 5, title: "арбуз отчёт", server: "sl-1" },
    ],
  }, (sources) => {
    assertEquals(
      resolveSelector(sources, "отчёт").candidates.map((c) => c.spreadsheetId),
      ["ss-c", "ss-a", "ss-b"],
    );
  });
});

Deno.test("пустой селектор отклоняется до обращения к кэшу", async (t) => {
  const cases: readonly (readonly [string, string])[] = [
    ["пустая строка", ""],
    ["одни пробелы", "  \t "],
  ];
  for (const [name, value] of cases) {
    await t.step(name, () => {
      const err = assertThrows(
        () => resolveSelector(untouchable, value),
        SelectorError,
      );
      assertEquals(err.message, "empty selector");
      assertEquals(err.candidates, []);
    });
  }
  await t.step("с override сервер назван флагом — отказа нет", () => {
    assertEquals(
      resolveSelector(untouchable, "", { server: "sl-1" }).serverNumber,
      1,
    );
  });
});

Deno.test("вердикт: несколько кандидатов на одном сервере — успех", async () => {
  await withCache({
    clients: [{ id: 5, server: "sl-1" }, { id: 6, server: "sl-1" }],
    spreadsheets: [
      { ssId: "ss-5", clientId: 5, title: "общий заголовок", server: "sl-1" },
      { ssId: "ss-6", clientId: 6, title: "общий заголовок", server: "sl-1" },
    ],
  }, (sources) => {
    assertEquals(resolveSelector(sources, "общий").serverNumber, 1);
  });
});

Deno.test("кэш-БД не инициализирована: одна ошибка на всех путях поиска", async (t) => {
  const paths: readonly (readonly [string, string])[] = [
    ["email", "nosuch@example.com"],
    ["client_id", "42"],
    ["отрицательный client_id", "-42"],
    ["sid", "wb-a"],
    ["spreadsheet_id", "ss-alpha"],
    ["заголовок", "Отчёт"],
    ["IP вне конфига", "10.9.9.9"],
  ];
  await withCache(undefined, async (sources) => {
    for (const [name, value] of paths) {
      await t.step(name, () => {
        const err = assertThrows(
          () => resolveSelector(sources, value),
          SelectorError,
        );
        assertEquals(err.message, "кэш-БД не инициализирована");
        assertEquals(err.hint, "mpu init");
        assertEquals(
          formatCommandError(["sql-ro"], err),
          "mpu sql-ro: кэш-БД не инициализирована; попробуй: mpu init",
        );
      });
    }
  });
});

Deno.test("кэш-БД без части таблиц — та же ошибка, не частичный ответ", async () => {
  await withCache(ONE_CLIENT, (sources, db) => {
    // Кэш от старой версии: схема есть, но одной из читаемых резолвом
    // таблиц в ней нет. Ответить «sid'ов нет» значило бы выдать неполноту
    // за факт — резолв отказывает так же, как на пустой БД.
    db.execute("DROP TABLE sl_wb_sids");
    const err = assertThrows(
      () => resolveSelector(sources, "7"),
      SelectorError,
    );
    assertEquals(err.message, "кэш-БД не инициализирована");
    assertEquals(err.hint, "mpu init");
  });
});

Deno.test("кэш-БД не инициализирована: пути без кэша работают", async () => {
  await withCache(undefined, (sources) => {
    const env = envOf({ sl_2: "10.0.0.2" });
    assertEquals(resolveSelector(sources, "sl-5").serverNumber, 5);
    assertEquals(
      resolveSelector(sources, "x", { server: "sl-6" }).serverNumber,
      6,
    );
    assertEquals(
      resolveSelector({ ...sources, env }, "10.0.0.2").serverNumber,
      2,
    );
  });
});

Deno.test("вторая ступень: успех — единственный client_id", async () => {
  await withCache(ONE_CLIENT, (sources) => {
    assertEquals(requireSingleClient(resolveSelector(sources, "7")), 7);
  });
});

Deno.test("вторая ступень: селектор указал только сервер", () => {
  assertEquals(
    messageOf(() => requireSingleClient(resolveSelector(untouchable, "sl-3"))),
    "selector 'sl-3' resolved to sl-3 but does not point to a specific " +
      "client; pass client_id / spreadsheet / title",
  );
});

Deno.test("вторая ступень: у кандидатов нет client_id", async () => {
  await withCache(ONE_CLIENT, (sources) => {
    const env = envOf({ sl_3: "10.0.0.3" });
    const resolved = resolveSelector({ ...sources, env }, "10.0.0.3");
    const err = assertThrows(
      () => requireSingleClient(resolved),
      SelectorError,
    );
    assertEquals(
      err.message,
      "selector resolved to a server but no client_id; use a selector " +
        "that points to a specific client",
    );
    assertEquals(err.candidates, resolved.candidates);
  });
});

Deno.test("вторая ступень: кандидаты у нескольких клиентов", async () => {
  await withCache({
    clients: [{ id: 5, server: "sl-1" }, { id: 6, server: "sl-1" }],
    spreadsheets: [
      { ssId: "ss-5", clientId: 5, title: "общий заголовок", server: "sl-1" },
      { ssId: "ss-5b", clientId: 5, title: "общий заголовок", server: "sl-1" },
      { ssId: "ss-6", clientId: 6, title: "общий заголовок", server: "sl-1" },
    ],
  }, (sources) => {
    const err = assertThrows(
      () => requireSingleClient(resolveSelector(sources, "общий")),
      SelectorError,
    );
    // Кандидатов три, клиентов два: считаются различные client_id.
    assertEquals(err.message, "selector matches 2 clients — narrow it down");
    assertEquals(err.candidates.length, 3);
  });
});

Deno.test("печать кандидатов: форма строки дословно", () => {
  const full: Candidate = {
    clientId: 7,
    spreadsheetId: "ss-alpha",
    title: "Отчёт alpha",
    server: "sl-1",
    serverNumber: 1,
    sids: ["wb-a"],
  };
  const bare: Candidate = {
    clientId: null,
    spreadsheetId: null,
    title: null,
    server: null,
    serverNumber: null,
    sids: [],
  };
  assertEquals(
    formatCandidates([full]),
    '  client_id=7  server=sl-1  title="Отчёт alpha"  ' +
      "spreadsheet_id=ss-alpha\n",
  );
  assertEquals(formatCandidates([bare]), "  client_id=  server=\n");
  assertEquals(
    formatCandidates([{ ...full, title: "" }]),
    "  client_id=7  server=sl-1  spreadsheet_id=ss-alpha\n",
  );
  assertEquals(
    formatCandidates([{ ...full, spreadsheetId: null }]),
    '  client_id=7  server=sl-1  title="Отчёт alpha"\n',
  );
  assertEquals(
    formatCandidates([full, bare]),
    [
      '  client_id=7  server=sl-1  title="Отчёт alpha"  spreadsheet_id=ss-alpha',
      "  client_id=  server=",
      "",
    ].join("\n"),
  );
  assertEquals(formatCandidates([]), "");
});

Deno.test("резолв не мутирует кэш-БД", async () => {
  await withCache(ONE_CLIENT, (sources, db) => {
    const before = db.query("SELECT COUNT(*) AS n FROM sl_spreadsheets");
    resolveSelector(sources, "7");
    resolveSelector(sources, "7");
    assertEquals(db.query("SELECT COUNT(*) AS n FROM sl_spreadsheets"), before);
  });
});

Deno.test("узкие интерфейсы: резолву довольно query и values", async () => {
  // Порт объявлен на стороне потребителя: тест собирает источники из
  // голых функций, без `CacheDb` и без слоя env-файла.
  await withCache(ONE_CLIENT, (sources) => {
    const cache: CacheReader = { query: sources.cache.query };
    const resolved: Resolved = resolveSelector(
      { cache, env: envOf({}) },
      "7",
    );
    assertEquals(resolved.serverNumber, 1);
  });
});
