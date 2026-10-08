/**
 * Прогрев справочников Kaiten (`docs/specs/platform/kaiten-http.md`,
 * раздел «Прогрев справочников»; `docs/specs/init.md`, шаг 4) на фейковом
 * HTTP-сервере:
 * happy path на golden-фикстурах, независимость частей 1/4 и 2/3 друг от
 * друга, пропуск одной доски без остановки обхода, retry на 429 (пауза
 * и исчерпание попыток), бюджет шага, отсутствие ключа в текстах ошибок и
 * запись `writeKaitenWarmup` поверх настоящей SQLite-БД (scoped-замена
 * дорожек/колонок).
 *
 * Фейковый сервер — общий стенд `serveFetch` (`@mpu/testing`, петля,
 * порт от ОС): обработчики здесь отвечают по самому запросу. Стенд
 * библиотеки (`startFakeKaiten`, `@mpu/kaiten/testing`) отдаёт ответчику
 * только накопленные разобранные запросы — перевод пятнадцати обработчиков на него вышел бы
 * за механический перевод тестов.
 *
 * Паузы retry в тестах — `Retry-After: 0` (задержка вырождается в
 * `setTimeout(0)`, не «сон стеной»; `ts/CLAUDE.md`: сон стеной в тестах
 * запрещён).
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
import { plainRows } from "@mpu/command/testing";
import { serveFetch } from "@mpu/testing";
import { KAITEN_TIMEOUTS, type KaitenAccess, KaitenError } from "@mpu/kaiten";
import { openCacheDb } from "@mpu/command/store";
import {
  collectKaitenWarmup,
  DEFAULT_KAITEN_LIMITS,
  type KaitenLimits,
  WARMUP_BUDGET_MS,
  writeKaitenWarmup,
} from "./mod.ts";

const API_KEY = "proba-kaiten-key-Q3z8Nw";

function accessTo(baseUrl: string): KaitenAccess {
  return { baseUrl, apiKey: API_KEY };
}

it("пределы прогрева по умолчанию — пределы Kaiten и бюджет не меньше 60 с", () => {
  // Бюджет короче предела одного вызова отдал бы в пропуски всё
  // недообойдённое из-за единственного медленного ответа
  // (`kaiten-http.md`, «Запрос»).
  expect(DEFAULT_KAITEN_LIMITS).toStrictEqual({
    timeouts: KAITEN_TIMEOUTS,
    budgetMs: WARMUP_BUDGET_MS,
  });
  expect(WARMUP_BUDGET_MS >= 60_000, `бюджет ${WARMUP_BUDGET_MS}ms`).toBe(true);
  // У вызова Kaiten предел обязан быть: `null` — «предела нет».
  const total = KAITEN_TIMEOUTS.totalTimeoutMs;
  expect(
    total !== null && WARMUP_BUDGET_MS > total,
    `бюджет ${WARMUP_BUDGET_MS}ms и предел вызова ${KAITEN_TIMEOUTS.totalTimeoutMs}ms`,
  ).toBe(true);
});

/** Бюджет-без-ограничения (реальные секунды) для сценариев не про бюджет. */
const AMPLE_LIMITS: KaitenLimits = DEFAULT_KAITEN_LIMITS;

async function readFixture(name: string): Promise<string> {
  return await readFile(new URL(`testdata/${name}`, import.meta.url), "utf8");
}

/** Временная кэш-БД с готовой схемой; уборка каталога — в `finally`. */
async function withBootstrappedDb(
  fn: (dbPath: string) => Promise<void> | void,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const dbPath = `${dir}/mpu.db`;
    using db = openCacheDb(dbPath);
    db.bootstrap();
    await fn(dbPath);
  } finally {
    await rm(dir, { recursive: true });
  }
}

// Сверку копий `testdata/*-ok.json` с каналом спецификаций держит
// `fixtures.test.ts` этого же модуля: два места одной проверки
// разошлись бы при добавлении новой фикстуры.

// --- happy path -------------------------------------------------------------

/**
 * Сервер на golden-фикстурах: `/spaces` и `/user-roles` отдают их как
 * есть; доска 501 (единственная, для которой в фикстурах есть строки)
 * отдаёт `lanes-ok.json`/`columns-ok.json`, доска 502 — пустой список
 * (в фикстурах для неё данных нет, но запрос всё равно успешен — она
 * обязана попасть в `boardIds`).
 */
function goldenServer(
  fixtures: Readonly<Record<string, string>>,
  onRequest?: (req: Request) => void,
): ReturnType<typeof serveFetch> {
  return serveFetch((req) => {
    onRequest?.(req);
    const { pathname } = new URL(req.url);
    if (pathname === "/api/latest/spaces") {
      return new Response(fixtures["spaces"]);
    }
    if (pathname === "/api/latest/user-roles") {
      return new Response(fixtures["roles"]);
    }
    if (pathname === "/api/latest/boards/501/lanes") {
      return new Response(fixtures["lanes"]);
    }
    if (pathname === "/api/latest/boards/501/columns") {
      return new Response(fixtures["columns"]);
    }
    if (
      pathname === "/api/latest/boards/502/lanes" ||
      pathname === "/api/latest/boards/502/columns"
    ) {
      return new Response("[]");
    }
    return new Response(null, { status: 404 });
  });
}

async function loadGoldenFixtures(): Promise<Readonly<Record<string, string>>> {
  return {
    spaces: await readFixture("spaces-ok.json"),
    lanes: await readFixture("lanes-ok.json"),
    columns: await readFixture("columns-ok.json"),
    roles: await readFixture("roles-ok.json"),
  };
}

it("happy path: 2 space, 2 board, дорожки и колонки обеих досок, 2 роли", async () => {
  const fixtures = await loadGoldenFixtures();
  const seen: Array<{ readonly path: string; readonly auth: string | null }> =
    [];
  const { baseUrl, stop } = await goldenServer(fixtures, (req) => {
    const { pathname } = new URL(req.url);
    seen.push({ path: pathname, auth: req.headers.get("authorization") });
  });
  try {
    const warmup = await collectKaitenWarmup(accessTo(baseUrl), AMPLE_LIMITS);

    expect(warmup.spaces).toStrictEqual([
      { id: 101, title: "Разработка", archived: false },
      { id: 102, title: "Архивное пространство", archived: true },
    ]);
    expect(warmup.boards).toStrictEqual([
      { id: 501, spaceId: 101, title: "Основная доска" },
      { id: 502, spaceId: 101, title: "Баги" },
    ]);
    expect(warmup.lanes).toStrictEqual({
      boardIds: [501, 502],
      rows: [
        { id: 9001, boardId: 501, title: "Обычные" },
        { id: 9002, boardId: 501, title: "Срочные" },
      ],
    });
    expect(warmup.columns).toStrictEqual({
      boardIds: [501, 502],
      rows: [
        { id: 7001, boardId: 501, title: "Очередь" },
        { id: 7002, boardId: 501, title: "В работе" },
        { id: 7003, boardId: 501, title: "Готово" },
      ],
    });
    expect(warmup.roles).toStrictEqual([
      { id: 11, name: "Разработка" },
      { id: 12, name: "Аналитика" },
    ]);
    expect(warmup.skips).toStrictEqual([]);

    // Каждый запрос — под /api/latest и с правильным Bearer-токеном.
    expect(seen.length > 0).toBe(true);
    for (const { path, auth } of seen) {
      expect(
        path.startsWith("/api/latest/"),
        `путь не под /api/latest: ${path}`,
      ).toBe(true);
      expect(auth).toStrictEqual(`Bearer ${API_KEY}`);
    }
    const paths = seen.map((s) => s.path).sort();
    expect(paths).toStrictEqual([
      "/api/latest/boards/501/columns",
      "/api/latest/boards/501/lanes",
      "/api/latest/boards/502/columns",
      "/api/latest/boards/502/lanes",
      "/api/latest/spaces",
      "/api/latest/user-roles",
    ]);
  } finally {
    await stop();
  }
});

// --- ошибка части 1 ---------------------------------------------------------

it("ошибка части 1 (/spaces): collectKaitenWarmup бросает KaitenError", async () => {
  const { baseUrl, stop } = await serveFetch((req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/latest/spaces") {
      return new Response("upstream boom", { status: 500 });
    }
    return new Response("[]");
  });
  try {
    const err = await rejected(
      () => collectKaitenWarmup(accessTo(baseUrl), AMPLE_LIMITS),
      KaitenError,
    );
    expect(err.message).toContain("kaiten GET /spaces -> 500: upstream boom");
    expect(err.message).toBe("kaiten GET /spaces -> 500: upstream boom");
  } finally {
    await stop();
  }
});

// --- испорченная форма тела --------------------------------------------------

describe("тело успешного ответа не той формы — ошибка запроса, не пустой справочник", () => {
  // Вердикт спецификатора 2026-08-05 (`kaiten-http.md`, «Запрос»): и
  // не-JSON, и валидный JSON не-массив — одинаково ошибка. Иначе
  // испорченный ответ молча заменил бы справочник пустым, и пустой
  // справочник от испорченного ответа было бы не отличить.
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["объект вместо массива", '{"items": []}', "ответ не JSON-массив"],
    ["строка вместо массива", '"нет"', "ответ не JSON-массив"],
    ["null вместо массива", "null", "ответ не JSON-массив"],
    ["тело не JSON", "точно не json{", "ответ не JSON"],
  ];

  describe("часть 1: весь шаг отказывает", () => {
    for (const [name, body, reason] of cases) {
      it(name, async () => {
        const { baseUrl, stop } = await serveFetch(() => new Response(body));
        try {
          const err = await rejected(
            () => collectKaitenWarmup(accessTo(baseUrl), AMPLE_LIMITS),
            KaitenError,
          );
          expect(err.message).toStrictEqual(`kaiten GET /spaces: ${reason}`);
        } finally {
          await stop();
        }
      });
    }
  });

  it("часть 2: пропуск доски с той же причиной", async () => {
    const fixtures = await loadGoldenFixtures();
    const { baseUrl, stop } = await serveFetch((req) => {
      const { pathname } = new URL(req.url);
      if (pathname === "/api/latest/spaces") {
        return new Response(fixtures["spaces"]);
      }
      if (pathname === "/api/latest/boards/502/lanes") {
        return new Response('{"lanes": []}');
      }
      if (pathname.endsWith("/lanes")) return new Response(fixtures["lanes"]);
      return new Response("[]");
    });
    try {
      const warmup = await collectKaitenWarmup(accessTo(baseUrl), AMPLE_LIMITS);
      expect(warmup.skips).toStrictEqual([
        {
          boardId: 502,
          reason: "kaiten GET /boards/502/lanes: ответ не JSON-массив",
        },
      ]);
      // Обход не оборван: здоровая доска собрана.
      expect(warmup.lanes?.boardIds).toStrictEqual([501]);
    } finally {
      await stop();
    }
  });

  it("пустое тело — отсутствие данных, а не ошибка", async () => {
    const { baseUrl, stop } = await serveFetch(() => new Response(""));
    try {
      const warmup = await collectKaitenWarmup(accessTo(baseUrl), AMPLE_LIMITS);
      expect(warmup.spaces).toStrictEqual([]);
      expect(warmup.boards).toStrictEqual([]);
      expect(warmup.roles).toStrictEqual([]);
    } finally {
      await stop();
    }
  });
});

// --- ошибка части 4 ---------------------------------------------------------

it("ошибка части 4 (/user-roles): roles: null, остальное собрано", async () => {
  const fixtures = await loadGoldenFixtures();
  const { baseUrl, stop } = await serveFetch((req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/latest/user-roles") {
      return new Response("roles are down", { status: 503 });
    }
    if (pathname === "/api/latest/spaces") {
      return new Response(fixtures["spaces"]);
    }
    if (pathname === "/api/latest/boards/501/lanes") {
      return new Response(fixtures["lanes"]);
    }
    if (pathname === "/api/latest/boards/501/columns") {
      return new Response(fixtures["columns"]);
    }
    return new Response("[]");
  });
  try {
    const warmup = await collectKaitenWarmup(accessTo(baseUrl), AMPLE_LIMITS);
    expect(warmup.roles).toStrictEqual(null);
    expect(warmup.spaces.length).toBe(2);
    expect(warmup.boards.length).toBe(2);
    expect(warmup.lanes !== null).toBe(true);
    expect(warmup.columns !== null).toBe(true);
  } finally {
    await stop();
  }
});

// --- пропуск одной доски в части 2 ------------------------------------------

it("ошибка одной доски в части 2: skips одна запись, часть не null", async () => {
  const fixtures = await loadGoldenFixtures();
  const { baseUrl, stop } = await serveFetch((req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/latest/spaces") {
      return new Response(fixtures["spaces"]);
    }
    if (pathname === "/api/latest/user-roles") {
      return new Response(fixtures["roles"]);
    }
    if (pathname === "/api/latest/boards/501/lanes") {
      return new Response(fixtures["lanes"]);
    }
    if (pathname === "/api/latest/boards/502/lanes") {
      return new Response("board is on fire", { status: 500 });
    }
    if (pathname === "/api/latest/boards/501/columns") {
      return new Response(fixtures["columns"]);
    }
    if (pathname === "/api/latest/boards/502/columns") {
      return new Response("[]");
    }
    return new Response(null, { status: 404 });
  });
  try {
    const warmup = await collectKaitenWarmup(accessTo(baseUrl), AMPLE_LIMITS);
    expect(warmup.skips).toStrictEqual([
      {
        boardId: 502,
        reason: "kaiten GET /boards/502/lanes -> 500: board is on fire",
      },
    ]);
    expect(warmup.lanes !== null).toBe(true);
    expect(warmup.lanes?.boardIds).toStrictEqual([501]);
    expect(warmup.lanes?.rows).toStrictEqual([
      { id: 9001, boardId: 501, title: "Обычные" },
      { id: 9002, boardId: 501, title: "Срочные" },
    ]);
    // Колонки не пострадали — своя часть, своя конкурентность.
    expect(warmup.columns?.boardIds).toStrictEqual([501, 502]);
  } finally {
    await stop();
  }
});

// --- ошибка всех досок -------------------------------------------------------

it("ошибка всех досок в части 2: lanes: null", async () => {
  const fixtures = await loadGoldenFixtures();
  const { baseUrl, stop } = await serveFetch((req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/latest/spaces") {
      return new Response(fixtures["spaces"]);
    }
    if (pathname === "/api/latest/user-roles") {
      return new Response(fixtures["roles"]);
    }
    if (pathname.endsWith("/lanes")) {
      return new Response("nope", { status: 500 });
    }
    if (pathname === "/api/latest/boards/501/columns") {
      return new Response(fixtures["columns"]);
    }
    if (pathname === "/api/latest/boards/502/columns") {
      return new Response("[]");
    }
    return new Response(null, { status: 404 });
  });
  try {
    const warmup = await collectKaitenWarmup(accessTo(baseUrl), AMPLE_LIMITS);
    expect(warmup.lanes).toStrictEqual(null);
    expect(warmup.skips.length).toBe(2);
    expect(
      warmup.skips.map((s) => s.boardId).sort((a, b) => a - b),
    ).toStrictEqual([501, 502]);
    expect(warmup.columns !== null).toBe(true);
  } finally {
    await stop();
  }
});

// --- 429: один повтор ---------------------------------------------------------

it("429 с Retry-After: 0 → один повтор, строка в notes, затем успех", async () => {
  const fixtures = await loadGoldenFixtures();
  let spacesCalls = 0;
  const { baseUrl, stop } = await serveFetch((req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/latest/spaces") {
      spacesCalls++;
      if (spacesCalls === 1) {
        return new Response("slow down", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(fixtures["spaces"]);
    }
    if (pathname === "/api/latest/user-roles") {
      return new Response(fixtures["roles"]);
    }
    if (pathname.endsWith("/lanes") || pathname.endsWith("/columns")) {
      return new Response("[]");
    }
    return new Response(null, { status: 404 });
  });
  try {
    const warmup = await collectKaitenWarmup(accessTo(baseUrl), AMPLE_LIMITS);
    expect(spacesCalls).toBe(2);
    expect(warmup.notes).toStrictEqual(["[kaiten] 429 rate-limit, sleep 0s"]);
    expect(warmup.spaces.length).toBe(2);
  } finally {
    await stop();
  }
});

// --- 429: исчерпание попыток ---------------------------------------------------

it("шесть 429 подряд: ошибка exhausted retries как причина пропуска доски", async () => {
  const fixtures = await loadGoldenFixtures();
  let laneCalls501 = 0;
  const { baseUrl, stop } = await serveFetch((req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/latest/spaces") {
      return new Response(fixtures["spaces"]);
    }
    if (pathname === "/api/latest/user-roles") {
      return new Response(fixtures["roles"]);
    }
    if (pathname === "/api/latest/boards/501/lanes") {
      laneCalls501++;
      return new Response("slow down", {
        status: 429,
        headers: { "retry-after": "0" },
      });
    }
    if (pathname.endsWith("/lanes") || pathname.endsWith("/columns")) {
      return new Response("[]");
    }
    return new Response(null, { status: 404 });
  });
  try {
    const warmup = await collectKaitenWarmup(accessTo(baseUrl), AMPLE_LIMITS);
    expect(laneCalls501).toBe(6);
    expect(warmup.skips).toStrictEqual([
      {
        boardId: 501,
        reason: "kaiten GET /boards/501/lanes -> 429: exhausted retries",
      },
    ]);
    // 5 пауз retry (после попыток 1..5, шестая уже не повторяется).
    expect(warmup.notes).toStrictEqual(
      Array(5).fill("[kaiten] 429 rate-limit, sleep 0s"),
    );
    // Доска 502 (вторая из фикстуры spaces-ok.json) не пострадала — часть
    // не null: досок было больше одной, и хотя бы одна обошлась.
    expect(warmup.lanes).toStrictEqual({ boardIds: [502], rows: [] });
  } finally {
    await stop();
  }
});

// --- бюджет шага -------------------------------------------------------------

it("бюджет шага исчерпан: доски пропущены, части 1 и 4 всё равно собраны", async () => {
  const fixtures = await loadGoldenFixtures();
  const boardCalls: string[] = [];
  const { baseUrl, stop } = await serveFetch((req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/latest/spaces") {
      return new Response(fixtures["spaces"]);
    }
    if (pathname === "/api/latest/user-roles") {
      return new Response(fixtures["roles"]);
    }
    boardCalls.push(pathname);
    return new Response("[]");
  });
  try {
    // Первый вызов nowMs() — вычисление дедлайна (deadline = T + 0); все
    // последующие вызовы (внутри collectBoardPart/kaitenCallArray) обязаны
    // возвращать что-то позже дедлайна — реальный сон не нужен, дедлайн
    // "давно прошёл" по значениям самой функции времени.
    let calls = 0;
    const nowMs = () => {
      calls++;
      return calls === 1 ? 1_000 : 999_999;
    };
    const start = performance.now();
    const warmup = await collectKaitenWarmup(
      accessTo(baseUrl),
      { timeouts: AMPLE_LIMITS.timeouts, budgetMs: 0 },
      nowMs,
    );
    // Бюджет — не сон стеной: пропуск доски определяется значениями
    // `nowMs()`, а не ожиданием реального времени (`ts/CLAUDE.md`).
    expect(
      performance.now() - start < 200,
      "исчерпание бюджета не должно ждать реальное время",
    ).toBe(true);

    expect(warmup.lanes).toStrictEqual(null);
    expect(warmup.columns).toStrictEqual(null);
    expect(warmup.skips.length).toBe(4); // 2 доски × 2 части (lanes, columns)
    for (const skip of warmup.skips) {
      expect(skip.reason).toBe("бюджет шага исчерпан");
    }
    // Части 1 и 4 не проверяют бюджет — собраны как обычно.
    expect(warmup.spaces.length).toBe(2);
    expect(warmup.boards.length).toBe(2);
    expect(warmup.roles?.length).toBe(2);
    // Ни один запрос доски не дошёл до сервера — бюджет остановил его
    // раньше, чем ушёл HTTP-вызов.
    expect(boardCalls).toStrictEqual([]);
  } finally {
    await stop();
  }
});

// --- секреты -------------------------------------------------------------------

describe("API-ключ не появляется в текстах ошибок", () => {
  it("ошибка части 1 (не-2xx)", async () => {
    const { baseUrl, stop } = await serveFetch(
      () => new Response("nope", { status: 500 }),
    );
    try {
      const err = await rejected(
        () => collectKaitenWarmup(accessTo(baseUrl), AMPLE_LIMITS),
        KaitenError,
      );
      expect(err.message.includes(API_KEY)).toBe(false);
      const causeText =
        err.cause instanceof Error ? err.cause.message : String(err.cause);
      expect(causeText.includes(API_KEY)).toBe(false);
      expect((err.stack ?? "").includes(API_KEY)).toBe(false);
    } finally {
      await stop();
    }
  });

  it("skip доски: причина без ключа", async () => {
    const fixtures = await loadGoldenFixtures();
    const { baseUrl, stop } = await serveFetch((req) => {
      const { pathname } = new URL(req.url);
      if (pathname === "/api/latest/spaces") {
        return new Response(fixtures["spaces"]);
      }
      if (pathname === "/api/latest/user-roles") {
        return new Response(fixtures["roles"]);
      }
      if (pathname.endsWith("/lanes")) {
        return new Response("boom", { status: 500 });
      }
      return new Response("[]");
    });
    try {
      const warmup = await collectKaitenWarmup(accessTo(baseUrl), AMPLE_LIMITS);
      for (const skip of warmup.skips) {
        expect(skip.reason.includes(API_KEY)).toBe(false);
      }
    } finally {
      await stop();
    }
  });

  it("сетевой сбой (HttpCallError): причина без ключа", async () => {
    // Часть 1 и часть 4 идут двумя одновременными запросами — общий
    // "затвор" вместо общего `Response`: тело читается один раз, а сервер
    // отдаёт каждому запросу свежий объект (см.
    // `tslibs/portainer/src/portainer.test.ts`, тест "гонка таймеров"). Общий `Response`-промис отдал бы один и тот
    // же поток телу второго запроса и упал бы "body already consumed".
    const gate = Promise.withResolvers<void>();
    const { baseUrl, stop } = await serveFetch(async () => {
      await gate.promise;
      return new Response("[]");
    });
    try {
      const err = await rejected(
        () =>
          collectKaitenWarmup(accessTo(baseUrl), {
            timeouts: { headersTimeoutMs: 20, totalTimeoutMs: 200 },
            budgetMs: AMPLE_LIMITS.budgetMs,
          }),
        KaitenError,
      );
      expect(err.message.includes(API_KEY)).toBe(false);
    } finally {
      gate.resolve();
      await stop();
    }
  });
});

// --- writeKaitenWarmup --------------------------------------------------------

const EMPTY_WARMUP = {
  spaces: [],
  boards: [],
  lanes: null,
  columns: null,
  roles: null,
  skips: [],
  notes: [],
} as const;

it("writeKaitenWarmup: полная замена spaces/boards/roles", async () => {
  await withBootstrappedDb((dbPath) => {
    using db = openCacheDb(dbPath);

    writeKaitenWarmup(
      db,
      {
        ...EMPTY_WARMUP,
        spaces: [{ id: 101, title: "Разработка", archived: false }],
        boards: [{ id: 501, spaceId: 101, title: "Основная доска" }],
        roles: [{ id: 11, name: "Разработка" }],
      },
      1_000,
    );

    expect(
      plainRows(
        db.query(
          "SELECT id, title, archived, discovered_at FROM kaiten_spaces",
        ),
      ),
    ).toStrictEqual([
      {
        id: 101,
        title: "Разработка",
        archived: 0,
        discovered_at: 1_000,
      },
    ]);
    expect(
      plainRows(
        db.query(
          "SELECT id, space_id, title, discovered_at FROM kaiten_boards",
        ),
      ),
    ).toStrictEqual([
      {
        id: 501,
        space_id: 101,
        title: "Основная доска",
        discovered_at: 1_000,
      },
    ]);
    expect(
      plainRows(db.query("SELECT id, name, discovered_at FROM kaiten_roles")),
    ).toStrictEqual([{ id: 11, name: "Разработка", discovered_at: 1_000 }]);

    // Второй вызов с другим набором — старые строки не остаются
    // (полная замена, kaiten-http.md, «Побочные эффекты»).
    writeKaitenWarmup(
      db,
      {
        ...EMPTY_WARMUP,
        spaces: [{ id: 102, title: "Архив", archived: true }],
        boards: [],
        roles: [],
      },
      2_000,
    );

    expect(
      plainRows(
        db.query(
          "SELECT id, title, archived, discovered_at FROM kaiten_spaces",
        ),
      ),
    ).toStrictEqual([
      {
        id: 102,
        title: "Архив",
        archived: 1,
        discovered_at: 2_000,
      },
    ]);
    expect(db.query("SELECT id FROM kaiten_boards")).toStrictEqual([]);
    expect(db.query("SELECT id FROM kaiten_roles")).toStrictEqual([]);
  });
});

it("writeKaitenWarmup: scoped-замена дорожек — обойдённая доска заменена, необойдённая цела", async () => {
  await withBootstrappedDb((dbPath) => {
    using db = openCacheDb(dbPath);

    // Кэш уже содержит строки двух досок: 501 (будет обойдена заново) и
    // 777 (прогрев её не касался вовсе).
    db.execute(
      "INSERT INTO kaiten_lanes (id, board_id, title, discovered_at) VALUES (?, ?, ?, ?)",
      9001,
      501,
      "старая дорожка 501",
      500,
    );
    db.execute(
      "INSERT INTO kaiten_lanes (id, board_id, title, discovered_at) VALUES (?, ?, ?, ?)",
      9500,
      777,
      "дорожка чужой доски",
      500,
    );

    writeKaitenWarmup(
      db,
      {
        ...EMPTY_WARMUP,
        lanes: {
          boardIds: [501],
          rows: [{ id: 9002, boardId: 501, title: "новая дорожка 501" }],
        },
      },
      2_000,
    );

    expect(
      plainRows(
        db.query(
          "SELECT id, board_id, title, discovered_at FROM kaiten_lanes ORDER BY board_id, id",
        ),
      ),
    ).toStrictEqual([
      {
        id: 9002,
        board_id: 501,
        title: "новая дорожка 501",
        discovered_at: 2_000,
      },
      {
        id: 9500,
        board_id: 777,
        title: "дорожка чужой доски",
        discovered_at: 500,
      },
    ]);
  });
});

it("writeKaitenWarmup: lanes: null не трогает таблицу вовсе", async () => {
  await withBootstrappedDb((dbPath) => {
    using db = openCacheDb(dbPath);

    db.execute(
      "INSERT INTO kaiten_lanes (id, board_id, title, discovered_at) VALUES (?, ?, ?, ?)",
      9001,
      501,
      "дорожка до прогрева",
      500,
    );

    writeKaitenWarmup(db, { ...EMPTY_WARMUP, lanes: null }, 2_000);

    expect(
      plainRows(
        db.query("SELECT id, board_id, title, discovered_at FROM kaiten_lanes"),
      ),
    ).toStrictEqual([
      {
        id: 9001,
        board_id: 501,
        title: "дорожка до прогрева",
        discovered_at: 500,
      },
    ]);
  });
});
