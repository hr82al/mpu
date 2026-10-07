/**
 * Контрактные тесты платформенного резолва селектора
 * (`docs/specs/platform/selector.md`): порядок разбора, порядок
 * предикатов, вердикт по множеству серверов, вторая ступень и печать
 * кандидатов. Кэш — синтетический: временный файл SQLite через
 * `openCacheDb` (как в `../update/cache.test.ts`), заполняется прямо в
 * тесте. Сети нет ни на одном пути.
 *
 * Тексты ошибок, снятые с живой версии, сверяются с копиями golden
 * (`testdata/`, сверка копий с каналом — `fixtures.test.ts`): префикс
 * команды в фикстуре — `mpu sql-ro:`, его подставляет тест через
 * `formatCommandError`, потому что сама команда ещё не перенесена.
 */

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTempCache, plainRows } from "../testing/cache.ts";
import { thrown } from "@mpu/testing/thrown";
import { type CacheDb, formatCommandError } from "../command/mod.ts";
import {
  type CacheReader,
  type Candidate,
  formatCandidates,
  isServerAddressLike,
  requireSingleClient,
  type Resolved,
  resolveSelector,
  searchCandidates,
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
  const { sources, db, close } = await openCache(cache);
  try {
    await body(sources, db);
  } finally {
    await close();
  }
}

/**
 * Та же кэш-БД на весь `describe`: открывается в `beforeAll`, `close` — в
 * `afterAll`.
 */
async function openCache(cache: Cache | undefined): Promise<{
  sources: SelectorSources;
  db: CacheDb;
  close: () => Promise<void>;
}> {
  const { db, close } = await openTempCache((db) => {
    if (cache !== undefined) fill(db, cache);
  });
  return { sources: { cache: db, env: envOf({}) }, db, close };
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
  sids: [
    { sid: "wb-b", clientId: 7 },
    { sid: "wb-a", clientId: 7 },
  ],
};

function golden(name: string): string {
  return readFileSync(
    new URL(`testdata/${name}`, import.meta.url),
    "utf8",
  ).trimEnd();
}

function messageOf(fn: () => unknown): string {
  const err = thrown(fn, SelectorError);
  return (err as SelectorError).message;
}

function candidatesOf(fn: () => unknown): readonly Candidate[] {
  const err = thrown(fn, SelectorError);
  return (err as SelectorError).candidates;
}

it("override --server: замещает value, кэш не читается", () => {
  expect(resolveSelector(untouchable, "7", { server: "sl-4" })).toStrictEqual({
    selector: "7",
    serverNumber: 4,
    candidates: [],
  });
});

it("override --server: невалидное значение — дословный текст", () => {
  const err = thrown(
    () => resolveSelector(untouchable, "7", { server: "foo" }),
    SelectorError,
  );
  expect(err.message).toBe("bad --server: 'foo' (expected sl-N)");
  expect(formatCommandError("sql-ro", err)).toStrictEqual(
    golden("err-bad-server.txt"),
  );
});

it("sl-N: короткий цикл строго приоритетнее поиска по кэшу", async () => {
  // В кэше есть таблица с подстрокой `sl-1` в заголовке — короткий цикл
  // не даёт ей ни единого шанса: кэш не читается вовсе (инвариант спеки).
  await withCache(
    {
      clients: [{ id: 3, server: "sl-9" }],
      spreadsheets: [
        { ssId: "ss-1", clientId: 3, title: "стенд sl-1", server: "sl-9" },
      ],
    },
    () => {
      expect(resolveSelector(untouchable, "sl-1")).toStrictEqual({
        selector: "sl-1",
        serverNumber: 1,
        candidates: [],
      });
    },
  );
  // sl-0 — обычный сервер, особых веток нет.
  expect(resolveSelector(untouchable, "sl-0").serverNumber).toBe(0);
});

it("client_id: кандидат на таблицу клиента, sid'ы по возрастанию", async () => {
  await withCache(ONE_CLIENT, (sources) => {
    expect(resolveSelector(sources, "7")).toStrictEqual({
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

it("client_id: клиент без таблиц — одна строка с null-полями", async () => {
  await withCache({ clients: [{ id: 8, server: "sl-2" }] }, (sources) => {
    expect(resolveSelector(sources, "8").candidates).toStrictEqual([
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

it("порядок предикатов: sid раньше spreadsheet_id", async () => {
  // Значение матчит и sid клиента 7, и подстроку ss_id клиента 9.
  await withCache(
    {
      clients: [
        { id: 7, server: "sl-1" },
        { id: 9, server: "sl-2" },
      ],
      spreadsheets: [
        { ssId: "ss-7", clientId: 7, title: "клиент 7", server: "sl-1" },
        { ssId: "ss-wb-a-9", clientId: 9, title: "клиент 9", server: "sl-2" },
      ],
      sids: [{ sid: "wb-a", clientId: 7 }],
    },
    (sources) => {
      const resolved = resolveSelector(sources, "wb-a");
      expect(resolved.serverNumber).toBe(1);
      expect(resolved.candidates.map((c) => c.clientId)).toStrictEqual([7]);
    },
  );
});

it("порядок предикатов: sid точный раньше подстроки", async () => {
  await withCache(
    {
      clients: [
        { id: 7, server: "sl-1" },
        { id: 9, server: "sl-2" },
      ],
      sids: [
        { sid: "wb-a", clientId: 9 },
        { sid: "wb-a-long", clientId: 7 },
      ],
    },
    (sources) => {
      // `wb-a` — точный sid клиента 9 и подстрока sid'а клиента 7:
      // побеждает точный, подстрочный поиск не выполняется.
      expect(
        resolveSelector(sources, "wb-a").candidates.map((c) => c.clientId),
      ).toStrictEqual([9]);
    },
  );
});

it("порядок предикатов: title только при пустом spreadsheet_id", async () => {
  await withCache(
    {
      clients: [
        { id: 7, server: "sl-1" },
        { id: 9, server: "sl-1" },
      ],
      spreadsheets: [
        { ssId: "ss-alpha", clientId: 7, title: "первый", server: "sl-1" },
        { ssId: "ss-9", clientId: 9, title: "отчёт alpha", server: "sl-1" },
      ],
    },
    (sources) => {
      // `alpha` есть и в ss_id клиента 7, и в заголовке клиента 9.
      expect(
        resolveSelector(sources, "alpha").candidates.map((c) => c.clientId),
      ).toStrictEqual([7]);
      // По заголовку ищем, только когда по ss_id пусто.
      expect(
        resolveSelector(sources, "отчёт").candidates.map((c) => c.clientId),
      ).toStrictEqual([9]);
    },
  );
});

it("email: клиенты из кэша email→клиент, регистр не важен", async () => {
  await withCache(
    {
      ...ONE_CLIENT,
      emails: [{ email: "client@example.com", owned: "[7]" }],
    },
    (sources) => {
      expect(
        resolveSelector(sources, "Client@Example.com").candidates.map(
          (c) => c.clientId,
        ),
      ).toStrictEqual([7, 7]);
    },
  );
});

it("email вне кэша: подсказка запустить поиск, дословно", async () => {
  await withCache(ONE_CLIENT, (sources) => {
    const err = thrown(
      () => resolveSelector(sources, "nosuch@example.com"),
      SelectorError,
    );
    expect(err.message).toStrictEqual(
      "email 'nosuch@example.com' не в кэше; " +
        "сначала запусти: mpu search nosuch@example.com",
    );
    expect(err.candidates).toStrictEqual([]);
    expect(formatCommandError("sql-ro", err)).toStrictEqual(
      golden("err-email-not-cached.txt"),
    );
  });
});

describe("email: нечитаемая строка кэша равнозначна её отсутствию", () => {
  // Решение записано в `.tmp/spec-request-selector.md`, п. 7: своей
  // ошибки «кэш повреждён» у резолва нет, а подсказка «запусти mpu
  // search» и есть способ строку перезаписать.
  const cases: readonly (readonly [string, string])[] = [
    ["значение не JSON", "'не json'"],
    ["JSON не массив", "'{\"client_id\": 7}'"],
    ["значение не текст", "x'00'"],
  ];
  for (const [name, literal] of cases) {
    it(name, async () => {
      await withCache(ONE_CLIENT, (sources, db) => {
        db.execute(
          "INSERT INTO x10_email_clients (email, target_user_id," +
            " target_name, is_email_verified, owned_client_ids," +
            " workspaces_json, reason, fetched_at)" +
            ` VALUES ('client@example.com', 'u-1', NULL, 1, ${literal},` +
            " '[]', 'тест', 0)",
        );
        expect(
          messageOf(() => resolveSelector(sources, "client@example.com")),
        ).toStrictEqual(
          "email 'client@example.com' не в кэше; " +
            "сначала запусти: mpu search client@example.com",
        );
      });
    });
  }
});

describe("испорченный кэш: столбец не того типа — ошибка с его именем", () => {
  // Столбцы объявлены схемой как NOT NULL, но SQLite хранит в них что
  // угодно: такой файл БД испорчен, и резолв обязан сказать это внятно,
  // а не подставить пустое значение и выдать чушь за кандидата.
  it("не целое в client_id", async () => {
    await withCache(ONE_CLIENT, (sources, db) => {
      db.execute(
        "INSERT INTO sl_spreadsheets (ss_id, client_id, title," +
          " template_name, is_active, server, synced_at)" +
          " VALUES ('ss-broken', 'не число', 'битая', NULL, 1, 'sl-1', 0)",
      );
      thrown(
        () => resolveSelector(sources, "ss-broken"),
        TypeError,
        "client_id: в кэш-БД не целое число",
      );
    });
  });
  it("не текст в sid", async () => {
    await withCache(ONE_CLIENT, (sources, db) => {
      db.execute(
        "INSERT INTO sl_wb_sids (sid, client_id, server, synced_at)" +
          " VALUES (x'00', 7, NULL, 0)",
      );
      thrown(
        () => resolveSelector(sources, "7"),
        TypeError,
        "sl_wb_sids.sid: в кэш-БД не текст",
      );
    });
  });
});

it("IP: номер сервера из env-файла, кандидат без клиента", async () => {
  await withCache(ONE_CLIENT, (sources) => {
    const env = envOf({
      sl_1: "10.0.0.1",
      pg_3: "10.0.1.3",
      sl_3: "10.0.0.3",
      sl_3_portainer: "10.0.0.3:9000",
    });
    expect(resolveSelector({ ...sources, env }, "10.0.1.3")).toStrictEqual({
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

it("IP: неизвестный адрес — nothing matched, дословно", async () => {
  await withCache(ONE_CLIENT, (sources) => {
    const env = envOf({ sl_1: "10.0.0.1" });
    expect(
      messageOf(() => resolveSelector({ ...sources, env }, "10.9.9.9")),
    ).toBe("nothing matched: '10.9.9.9'");
  });
});

it("IP: один адрес у разных серверов — ошибка конфигурации", async () => {
  await withCache(ONE_CLIENT, (sources) => {
    const env = envOf({ sl_1: "10.0.0.9", pg_4: "10.0.0.9", pg_1: "10.0.0.9" });
    expect(
      messageOf(() => resolveSelector({ ...sources, env }, "10.0.0.9")),
    ).toStrictEqual(
      "конфликт адресов в env-файле: '10.0.0.9' задан ключами " +
        "pg_1, pg_4, sl_1",
    );
  });
});

it("вердикт: ничего не найдено — дословный текст golden", async () => {
  await withCache(ONE_CLIENT, (sources) => {
    const err = thrown(
      () => resolveSelector(sources, "zzz-no-such-thing"),
      SelectorError,
    );
    expect(err.message).toBe("nothing matched: 'zzz-no-such-thing'");
    expect(formatCommandError("sql-ro", err)).toStrictEqual(
      golden("err-nothing-matched.txt"),
    );
  });
});

it("вердикт: клиент найден, но сервера нет", async () => {
  await withCache({ clients: [{ id: 9, server: null }] }, (sources) => {
    const err = thrown(() => resolveSelector(sources, "9"), SelectorError);
    expect(err.message).toBe("matched but no server resolvable: '9'");
    expect(err.candidates.map((c) => c.clientId)).toStrictEqual([9]);
  });
});

it("вердикт: клиент на двух серверах — ambiguous", async () => {
  await withCache(
    {
      clients: [{ id: 5, server: "sl-1" }],
      spreadsheets: [
        { ssId: "ss-1", clientId: 5, title: "а", server: "sl-1" },
        { ssId: "ss-2", clientId: 5, title: "б", server: "sl-1" },
        { ssId: "ss-3", clientId: 5, title: "в", server: "sl-2" },
      ],
    },
    (sources) => {
      // Кандидатов три, серверов два: число в тексте — число кандидатов,
      // то есть длина печатаемого следом списка.
      expect(messageOf(() => resolveSelector(sources, "5"))).toBe(
        "ambiguous selector '5' — 3 candidates on different servers",
      );
      expect(
        candidatesOf(() => resolveSelector(sources, "5")).map(
          (c) => c.spreadsheetId,
        ),
      ).toStrictEqual(["ss-1", "ss-2", "ss-3"]);
    },
  );
});

it("вердикт: кандидат без сервера в множестве не участвует", async () => {
  // preserve-отклонение спеки: 2 кандидата на sl-1 + 1 без сервера —
  // однозначный успех со всеми тремя в выдаче. Достижимо в ветке
  // заголовка: там кандидаты приходят от разных клиентов, а сервер
  // таблицы сервером её клиента (sl-9) не замещается.
  await withCache(
    {
      clients: [
        { id: 5, server: "sl-1" },
        { id: 6, server: "sl-9" },
      ],
      spreadsheets: [
        { ssId: "ss-1", clientId: 5, title: "общий отчёт", server: "sl-1" },
        { ssId: "ss-2", clientId: 5, title: "общий отчёт", server: "sl-1" },
        { ssId: "ss-3", clientId: 6, title: "общий отчёт", server: null },
      ],
    },
    (sources) => {
      const resolved = resolveSelector(sources, "общий");
      expect(resolved.serverNumber).toBe(1);
      expect(resolved.candidates.map((c) => c.spreadsheetId)).toStrictEqual([
        "ss-1",
        "ss-2",
        "ss-3",
      ]);
      expect(resolved.candidates.map((c) => c.server)).toStrictEqual([
        "sl-1",
        "sl-1",
        null,
      ]);
    },
  );
});

it("сервер кандидата: пустой у таблицы замещается сервером клиента", async () => {
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
      expect(resolved.serverNumber, `селектор: ${value}`).toBe(2);
      expect(resolved.candidates.map((c) => c.server)).toStrictEqual(["sl-2"]);
    }
  });
  await withCache(cache, (sources) => {
    // А в ветках поиска по таблице подстановки нет: сервера у таблицы
    // нет — значит его не вывести, и это matched but no server resolvable.
    expect(messageOf(() => resolveSelector(sources, "ss-4"))).toBe(
      "matched but no server resolvable: 'ss-4'",
    );
    expect(messageOf(() => resolveSelector(sources, "без сервера"))).toBe(
      "matched but no server resolvable: 'без сервера'",
    );
  });
});

describe("подстрочный поиск: шаблоны LIKE и регистр — контракт спеки", () => {
  let sources: SelectorSources;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ sources, close } = await openCache({
      clients: [{ id: 5, server: "sl-1" }],
      spreadsheets: [
        { ssId: "ss-abc", clientId: 5, title: "Отчёт ALPHA", server: "sl-1" },
      ],
    }));
  });
  afterAll(() => close());
  const found = (value: string) =>
    resolveSelector(sources, value).candidates.map((c) => c.spreadsheetId);

  it("% в значении — шаблон, а не литерал", () => {
    expect(found("ss%bc")).toStrictEqual(["ss-abc"]);
  });
  it("_ в значении — любой один символ", () => {
    expect(found("ss_abc")).toStrictEqual(["ss-abc"]);
  });
  it("регистр ASCII не учитывается", () => {
    expect(found("alpha")).toStrictEqual(["ss-abc"]);
  });
  it("регистр кириллицы учитывается", () => {
    expect(messageOf(() => resolveSelector(sources, "отчёт"))).toBe(
      "nothing matched: 'отчёт'",
    );
  });
});

it("порядок кандидатов: ветка таблицы — по spreadsheet_id", async () => {
  await withCache(
    {
      clients: [
        { id: 5, server: "sl-1" },
        { id: 6, server: "sl-1" },
      ],
      spreadsheets: [
        { ssId: "ss-b", clientId: 5, title: "первая", server: "sl-1" },
        { ssId: "ss-a", clientId: 6, title: "вторая", server: "sl-1" },
      ],
    },
    (sources) => {
      // Не по клиенту: таблица клиента 6 идёт первой, потому что её
      // spreadsheet_id меньше.
      expect(
        resolveSelector(sources, "ss-").candidates.map((c) => c.spreadsheetId),
      ).toStrictEqual(["ss-a", "ss-b"]);
    },
  );
});

it("порядок кандидатов: ветка заголовка — по заголовку, затем по таблице", async () => {
  await withCache(
    {
      clients: [{ id: 5, server: "sl-1" }],
      spreadsheets: [
        { ssId: "ss-b", clientId: 5, title: "яблоко отчёт", server: "sl-1" },
        { ssId: "ss-a", clientId: 5, title: "яблоко отчёт", server: "sl-1" },
        { ssId: "ss-c", clientId: 5, title: "арбуз отчёт", server: "sl-1" },
      ],
    },
    (sources) => {
      expect(
        resolveSelector(sources, "отчёт").candidates.map(
          (c) => c.spreadsheetId,
        ),
      ).toStrictEqual(["ss-c", "ss-a", "ss-b"]);
    },
  );
});

describe("пустой селектор отклоняется до обращения к кэшу", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["пустая строка", ""],
    ["одни пробелы", "  \t "],
  ];
  for (const [name, value] of cases) {
    it(name, () => {
      const err = thrown(
        () => resolveSelector(untouchable, value),
        SelectorError,
      );
      expect(err.message).toBe("empty selector");
      expect(err.candidates).toStrictEqual([]);
    });
  }
  it("с override сервер назван флагом — отказа нет", () => {
    expect(
      resolveSelector(untouchable, "", { server: "sl-1" }).serverNumber,
    ).toBe(1);
  });
});

it("вердикт: несколько кандидатов на одном сервере — успех", async () => {
  await withCache(
    {
      clients: [
        { id: 5, server: "sl-1" },
        { id: 6, server: "sl-1" },
      ],
      spreadsheets: [
        { ssId: "ss-5", clientId: 5, title: "общий заголовок", server: "sl-1" },
        { ssId: "ss-6", clientId: 6, title: "общий заголовок", server: "sl-1" },
      ],
    },
    (sources) => {
      expect(resolveSelector(sources, "общий").serverNumber).toBe(1);
    },
  );
});

describe("кэш-БД не инициализирована: одна ошибка на всех путях поиска", () => {
  const paths: readonly (readonly [string, string])[] = [
    ["email", "nosuch@example.com"],
    ["client_id", "42"],
    ["отрицательный client_id", "-42"],
    ["sid", "wb-a"],
    ["spreadsheet_id", "ss-alpha"],
    ["заголовок", "Отчёт"],
    ["IP вне конфига", "10.9.9.9"],
  ];
  let sources: SelectorSources;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ sources, close } = await openCache(undefined));
  });
  afterAll(() => close());
  for (const [name, value] of paths) {
    it(name, () => {
      const err = thrown(() => resolveSelector(sources, value), SelectorError);
      expect(err.message).toBe("кэш-БД не инициализирована");
      expect(err.hint).toBe("mpu init");
      expect(formatCommandError("sql-ro", err)).toBe(
        "mpu sql-ro: кэш-БД не инициализирована; попробуй: mpu init",
      );
    });
  }
});

describe("кэш-БД без части таблиц — та же ошибка, не частичный ответ", () => {
  // Кэш от старой версии: схема есть, но одной из читаемых резолвом
  // таблиц в ней нет. Ответить «sid'ов нет» или «email не в кэше»
  // значило бы выдать неполноту за факт — резолв отказывает так же, как
  // на пустой БД, и так для каждой из четырёх таблиц по отдельности.
  const tables: readonly string[] = [
    "sl_clients",
    "sl_spreadsheets",
    "sl_wb_sids",
    "x10_email_clients",
  ];
  for (const table of tables) {
    it(`нет таблицы ${table}`, async () => {
      await withCache(ONE_CLIENT, (sources, db) => {
        db.execute(`DROP TABLE ${table}`);
        const err = thrown(() => resolveSelector(sources, "7"), SelectorError);
        expect(err.message).toBe("кэш-БД не инициализирована");
        expect(err.hint).toBe("mpu init");
      });
    });
  }
});

it("кэш-БД не инициализирована: пути без кэша работают", async () => {
  await withCache(undefined, (sources) => {
    const env = envOf({ sl_2: "10.0.0.2" });
    expect(resolveSelector(sources, "sl-5").serverNumber).toBe(5);
    expect(resolveSelector(sources, "x", { server: "sl-6" }).serverNumber).toBe(
      6,
    );
    expect(resolveSelector({ ...sources, env }, "10.0.0.2").serverNumber).toBe(
      2,
    );
  });
});

it("вторая ступень: успех — единственный client_id", async () => {
  await withCache(ONE_CLIENT, (sources) => {
    expect(requireSingleClient(resolveSelector(sources, "7"))).toBe(7);
  });
});

it("вторая ступень: селектор указал только сервер", () => {
  expect(
    messageOf(() => requireSingleClient(resolveSelector(untouchable, "sl-3"))),
  ).toStrictEqual(
    "selector 'sl-3' resolved to sl-3 but does not point to a specific " +
      "client; pass client_id / spreadsheet / title",
  );
});

it("вторая ступень: у кандидатов нет client_id", async () => {
  await withCache(ONE_CLIENT, (sources) => {
    const env = envOf({ sl_3: "10.0.0.3" });
    const resolved = resolveSelector({ ...sources, env }, "10.0.0.3");
    const err = thrown(() => requireSingleClient(resolved), SelectorError);
    expect(err.message).toStrictEqual(
      "selector resolved to a server but no client_id; use a selector " +
        "that points to a specific client",
    );
    expect(err.candidates).toStrictEqual(resolved.candidates);
  });
});

it("вторая ступень: кандидаты у нескольких клиентов", async () => {
  await withCache(
    {
      clients: [
        { id: 5, server: "sl-1" },
        { id: 6, server: "sl-1" },
      ],
      spreadsheets: [
        { ssId: "ss-5", clientId: 5, title: "общий заголовок", server: "sl-1" },
        {
          ssId: "ss-5b",
          clientId: 5,
          title: "общий заголовок",
          server: "sl-1",
        },
        { ssId: "ss-6", clientId: 6, title: "общий заголовок", server: "sl-1" },
      ],
    },
    (sources) => {
      const err = thrown(
        () => requireSingleClient(resolveSelector(sources, "общий")),
        SelectorError,
      );
      // Кандидатов три, клиентов два: считаются различные client_id.
      expect(err.message).toBe("selector matches 2 clients — narrow it down");
      expect(err.candidates.length).toBe(3);
    },
  );
});

it("печать кандидатов: форма строки дословно", () => {
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
  expect(formatCandidates([full])).toStrictEqual(
    '  client_id=7  server=sl-1  title="Отчёт alpha"  ' +
      "spreadsheet_id=ss-alpha\n",
  );
  expect(formatCandidates([bare])).toBe("  client_id=  server=\n");
  expect(formatCandidates([{ ...full, title: "" }])).toBe(
    "  client_id=7  server=sl-1  spreadsheet_id=ss-alpha\n",
  );
  expect(formatCandidates([{ ...full, spreadsheetId: null }])).toBe(
    '  client_id=7  server=sl-1  title="Отчёт alpha"\n',
  );
  expect(formatCandidates([full, bare])).toStrictEqual(
    [
      '  client_id=7  server=sl-1  title="Отчёт alpha"  spreadsheet_id=ss-alpha',
      "  client_id=  server=",
      "",
    ].join("\n"),
  );
  expect(formatCandidates([])).toBe("");
});

it("резолв не мутирует кэш-БД", async () => {
  await withCache(ONE_CLIENT, (sources, db) => {
    const before = plainRows(
      db.query("SELECT COUNT(*) AS n FROM sl_spreadsheets"),
    );
    resolveSelector(sources, "7");
    resolveSelector(sources, "7");
    expect(
      plainRows(db.query("SELECT COUNT(*) AS n FROM sl_spreadsheets")),
    ).toStrictEqual(before);
  });
});

it("узкие интерфейсы: резолву довольно query и values", async () => {
  // Порт объявлен на стороне потребителя: тест собирает источники из
  // голых функций, без `CacheDb` и без слоя env-файла.
  await withCache(ONE_CLIENT, (sources) => {
    const cache: CacheReader = { query: sources.cache.query };
    const resolved: Resolved = resolveSelector({ cache, env: envOf({}) }, "7");
    expect(resolved.serverNumber).toBe(1);
  });
});

describe("кандидаты без вердикта: то же, что видит резолв", () => {
  it("совпавшие на разных серверах отдаются все", async () => {
    await withCache(
      {
        clients: [
          { id: 7, server: "sl-1" },
          { id: 8, server: "sl-2" },
        ],
        spreadsheets: [
          { ssId: "SS_A", clientId: 7, title: "Отчёт", server: "sl-1" },
          { ssId: "SS_B", clientId: 8, title: "Отчёт", server: "sl-2" },
        ],
      },
      (sources) => {
        // Резолву это неоднозначность (`ambiguous selector`), а поиску —
        // обычный ответ из двух строк: вердикт по серверам ему не подходит.
        expect(() => resolveSelector(sources, "Отчёт")).toThrow(SelectorError);
        const found = searchCandidates(sources, "Отчёт");
        expect(found.map((candidate) => candidate.spreadsheetId)).toStrictEqual(
          ["SS_A", "SS_B"],
        );
      },
    );
  });

  it("пустой селектор — отказ до чтения кэша", () => {
    // Иначе подстрочный предикат сматчил бы весь кэш (спека, отклонение
    // `fix`): источники здесь падают на любом обращении.
    thrown(
      () => searchCandidates(untouchable, "   "),
      SelectorError,
      "empty selector",
    );
  });

  it("схема кэш-БД проверяется так же, как у резолва", async () => {
    await withCache(undefined, (sources) => {
      thrown(
        () => searchCandidates(sources, "42"),
        SelectorError,
        "кэш-БД не инициализирована",
      );
    });
  });

  it("ничего не совпало — пустой список, не отказ", async () => {
    await withCache(ONE_CLIENT, (sources) => {
      expect(searchCandidates(sources, "SS_НЕТ")).toStrictEqual([]);
    });
  });
});

it("маска адреса сервера — одна на предикат и на автосинк", () => {
  for (const value of ["10.9.9.9", "1.2.3.4", "192.168.150.8"]) {
    expect(isServerAddressLike(value), value).toBe(true);
  }
  // Диапазон октетов маска не проверяет намеренно (отклонение
  // `preserve`), а вот на не-адрес не срабатывает.
  expect(isServerAddressLike("999.999.999.999")).toBe(true);
  for (const value of ["10.9.9", "sl-9", "42", "10.9.9.9.9", ""]) {
    expect(isServerAddressLike(value), value).toBe(false);
  }
});
