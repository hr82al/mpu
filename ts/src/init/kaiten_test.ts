/**
 * Клиент Kaiten (`docs/specs/platform/kaiten-http.md`, раздел «Прогрев
 * справочников»; `docs/specs/init.md`, шаг 4) на фейковом HTTP-сервере:
 * happy path на golden-фикстурах, независимость частей 1/4 и 2/3 друг от
 * друга, пропуск одной доски без остановки обхода, retry на 429 (пауза
 * и исчерпание попыток), бюджет шага, отсутствие ключа в текстах ошибок,
 * `requireKaitenAccess`, `retryDelayMs` и запись `writeKaitenWarmup`
 * поверх настоящей SQLite-БД (scoped-замена дорожек/колонок).
 *
 * Фейковый сервер — калька вспомогательной функции `portainer_test.ts`/
 * `loki_test.ts` (`Deno.serve({ port: 0 })` на петле); общего тестового
 * модуля под неё нет (та же причина дублирования, что у них — YAGNI).
 *
 * Паузы retry в тестах — либо `Retry-After: 0` (задержка вырождается в
 * `setTimeout(0)`, не «сон стеной»), либо прямая проверка чистой функции
 * `retryDelayMs` без реального ожидания (`ts/CLAUDE.md`: сон стеной в
 * тестах запрещён).
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { openCacheDb } from "../store/mod.ts";
import {
  collectKaitenWarmup,
  DEFAULT_KAITEN_LIMITS,
  type KaitenAccess,
  KaitenError,
  type KaitenLimits,
  requireKaitenAccess,
  retryDelayMs,
  writeKaitenWarmup,
} from "./kaiten.ts";

const API_KEY = "proba-kaiten-key-Q3z8Nw";

/** Поднимает фейковый Kaiten на петле; гасить `await stop()` в `finally`. */
function fakeServer(
  handler: (req: Request) => Response | Promise<Response>,
): { readonly baseUrl: string; readonly stop: () => Promise<void> } {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    handler,
  );
  return {
    baseUrl: `http://127.0.0.1:${server.addr.port}`,
    stop: () => server.shutdown(),
  };
}

function accessTo(baseUrl: string): KaitenAccess {
  return { baseUrl, apiKey: API_KEY };
}

/** Бюджет-без-ограничения (реальные секунды) для сценариев не про бюджет. */
const AMPLE_LIMITS: KaitenLimits = DEFAULT_KAITEN_LIMITS;

async function readFixture(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(`testdata/${name}`, import.meta.url));
}

/** Временная кэш-БД с готовой схемой; уборка каталога — в `finally`. */
async function withBootstrappedDb(
  fn: (dbPath: string) => Promise<void> | void,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    const dbPath = `${dir}/mpu.db`;
    using db = openCacheDb(dbPath);
    db.bootstrap();
    await fn(dbPath);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// Сверку копий `testdata/*-ok.json` с каналом спецификаций держит
// `fixtures_test.ts` — там же, где сверка остальных копий модуля: два
// места одной проверки разошлись бы при добавлении новой фикстуры.

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
): ReturnType<typeof fakeServer> {
  return fakeServer((req) => {
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

Deno.test("happy path: 2 space, 2 board, дорожки и колонки обеих досок, 2 роли", async () => {
  const fixtures = await loadGoldenFixtures();
  const seen: Array<{ readonly path: string; readonly auth: string | null }> =
    [];
  const { baseUrl, stop } = goldenServer(fixtures, (req) => {
    const { pathname } = new URL(req.url);
    seen.push({ path: pathname, auth: req.headers.get("authorization") });
  });
  try {
    const warmup = await collectKaitenWarmup(accessTo(baseUrl), AMPLE_LIMITS);

    assertEquals(warmup.spaces, [
      { id: 101, title: "Разработка", archived: false },
      { id: 102, title: "Архивное пространство", archived: true },
    ]);
    assertEquals(warmup.boards, [
      { id: 501, spaceId: 101, title: "Основная доска" },
      { id: 502, spaceId: 101, title: "Баги" },
    ]);
    assertEquals(warmup.lanes, {
      boardIds: [501, 502],
      rows: [
        { id: 9001, boardId: 501, title: "Обычные" },
        { id: 9002, boardId: 501, title: "Срочные" },
      ],
    });
    assertEquals(warmup.columns, {
      boardIds: [501, 502],
      rows: [
        { id: 7001, boardId: 501, title: "Очередь" },
        { id: 7002, boardId: 501, title: "В работе" },
        { id: 7003, boardId: 501, title: "Готово" },
      ],
    });
    assertEquals(warmup.roles, [
      { id: 11, name: "Разработка" },
      { id: 12, name: "Аналитика" },
    ]);
    assertEquals(warmup.skips, []);

    // Каждый запрос — под /api/latest и с правильным Bearer-токеном.
    assertEquals(seen.length > 0, true);
    for (const { path, auth } of seen) {
      assertEquals(
        path.startsWith("/api/latest/"),
        true,
        `путь не под /api/latest: ${path}`,
      );
      assertEquals(auth, `Bearer ${API_KEY}`);
    }
    const paths = seen.map((s) => s.path).sort();
    assertEquals(paths, [
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

Deno.test("ошибка части 1 (/spaces): collectKaitenWarmup бросает KaitenError", async () => {
  const { baseUrl, stop } = fakeServer((req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/latest/spaces") {
      return new Response("upstream boom", { status: 500 });
    }
    return new Response("[]");
  });
  try {
    const err = await assertRejects(
      () => collectKaitenWarmup(accessTo(baseUrl), AMPLE_LIMITS),
      KaitenError,
      "kaiten GET /spaces -> 500: upstream boom",
    );
    assertEquals(err.message, "kaiten GET /spaces -> 500: upstream boom");
  } finally {
    await stop();
  }
});

// --- испорченная форма тела --------------------------------------------------

Deno.test("тело успешного ответа не той формы — ошибка запроса, не пустой справочник", async (t) => {
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

  await t.step("часть 1: весь шаг отказывает", async (t2) => {
    for (const [name, body, reason] of cases) {
      await t2.step(name, async () => {
        const { baseUrl, stop } = fakeServer(() => new Response(body));
        try {
          const err = await assertRejects(
            () => collectKaitenWarmup(accessTo(baseUrl), AMPLE_LIMITS),
            KaitenError,
          );
          assertEquals(err.message, `kaiten GET /spaces: ${reason}`);
        } finally {
          await stop();
        }
      });
    }
  });

  await t.step("часть 2: пропуск доски с той же причиной", async () => {
    const fixtures = await loadGoldenFixtures();
    const { baseUrl, stop } = fakeServer((req) => {
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
      assertEquals(warmup.skips, [{
        boardId: 502,
        reason: "kaiten GET /boards/502/lanes: ответ не JSON-массив",
      }]);
      // Обход не оборван: здоровая доска собрана.
      assertEquals(warmup.lanes?.boardIds, [501]);
    } finally {
      await stop();
    }
  });

  await t.step("пустое тело — отсутствие данных, а не ошибка", async () => {
    const { baseUrl, stop } = fakeServer(() => new Response(""));
    try {
      const warmup = await collectKaitenWarmup(accessTo(baseUrl), AMPLE_LIMITS);
      assertEquals(warmup.spaces, []);
      assertEquals(warmup.boards, []);
      assertEquals(warmup.roles, []);
    } finally {
      await stop();
    }
  });
});

// --- ошибка части 4 ---------------------------------------------------------

Deno.test("ошибка части 4 (/user-roles): roles: null, остальное собрано", async () => {
  const fixtures = await loadGoldenFixtures();
  const { baseUrl, stop } = fakeServer((req) => {
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
    assertEquals(warmup.roles, null);
    assertEquals(warmup.spaces.length, 2);
    assertEquals(warmup.boards.length, 2);
    assertEquals(warmup.lanes !== null, true);
    assertEquals(warmup.columns !== null, true);
  } finally {
    await stop();
  }
});

// --- пропуск одной доски в части 2 ------------------------------------------

Deno.test("ошибка одной доски в части 2: skips одна запись, часть не null", async () => {
  const fixtures = await loadGoldenFixtures();
  const { baseUrl, stop } = fakeServer((req) => {
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
    assertEquals(warmup.skips, [
      {
        boardId: 502,
        reason: "kaiten GET /boards/502/lanes -> 500: board is on fire",
      },
    ]);
    assertEquals(warmup.lanes !== null, true);
    assertEquals(warmup.lanes?.boardIds, [501]);
    assertEquals(warmup.lanes?.rows, [
      { id: 9001, boardId: 501, title: "Обычные" },
      { id: 9002, boardId: 501, title: "Срочные" },
    ]);
    // Колонки не пострадали — своя часть, своя конкурентность.
    assertEquals(warmup.columns?.boardIds, [501, 502]);
  } finally {
    await stop();
  }
});

// --- ошибка всех досок -------------------------------------------------------

Deno.test("ошибка всех досок в части 2: lanes: null", async () => {
  const fixtures = await loadGoldenFixtures();
  const { baseUrl, stop } = fakeServer((req) => {
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
    assertEquals(warmup.lanes, null);
    assertEquals(warmup.skips.length, 2);
    assertEquals(
      warmup.skips.map((s) => s.boardId).sort((a, b) => a - b),
      [501, 502],
    );
    assertEquals(warmup.columns !== null, true);
  } finally {
    await stop();
  }
});

// --- 429: один повтор ---------------------------------------------------------

Deno.test("429 с Retry-After: 0 → один повтор, строка в notes, затем успех", async () => {
  const fixtures = await loadGoldenFixtures();
  let spacesCalls = 0;
  const { baseUrl, stop } = fakeServer((req) => {
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
    assertEquals(spacesCalls, 2);
    assertEquals(warmup.notes, ["[kaiten] 429 rate-limit, sleep 0s"]);
    assertEquals(warmup.spaces.length, 2);
  } finally {
    await stop();
  }
});

// --- 429: исчерпание попыток ---------------------------------------------------

Deno.test("шесть 429 подряд: ошибка exhausted retries как причина пропуска доски", async () => {
  const fixtures = await loadGoldenFixtures();
  let laneCalls501 = 0;
  const { baseUrl, stop } = fakeServer((req) => {
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
    assertEquals(laneCalls501, 6);
    assertEquals(warmup.skips, [
      {
        boardId: 501,
        reason: "kaiten GET /boards/501/lanes -> 429: exhausted retries",
      },
    ]);
    // 5 пауз retry (после попыток 1..5, шестая уже не повторяется).
    assertEquals(
      warmup.notes,
      Array(5).fill("[kaiten] 429 rate-limit, sleep 0s"),
    );
    // Доска 502 (вторая из фикстуры spaces-ok.json) не пострадала — часть
    // не null: досок было больше одной, и хотя бы одна обошлась.
    assertEquals(warmup.lanes, { boardIds: [502], rows: [] });
  } finally {
    await stop();
  }
});

// --- retryDelayMs: чистая функция расписания ------------------------------

Deno.test("retryDelayMs: табличный тест расписания пауз", async (t) => {
  const cases: ReadonlyArray<readonly [string, number, string | null, number]> =
    [
      ["Retry-After: 7 → 7000", 1, "7", 7_000],
      ["нет заголовка, попытка 1 → 1000", 1, null, 1_000],
      ["нет заголовка, попытка 2 → 2000", 2, null, 2_000],
      ["нет заголовка, попытка 3 → 4000", 3, null, 4_000],
      ["нет заголовка, попытка 4 → 8000", 4, null, 8_000],
      ["нет заголовка, попытка 5 → 16000", 5, null, 16_000],
      ["нет заголовка, попытка 6 → потолок 30000", 6, null, 30_000],
      [
        "нечисловое значение → как отсутствие (попытка 1)",
        1,
        "не-число",
        1_000,
      ],
    ];
  for (const [name, attempt, retryAfter, expected] of cases) {
    await t.step(name, () => {
      assertEquals(retryDelayMs(attempt, retryAfter), expected);
    });
  }
});

// --- бюджет шага -------------------------------------------------------------

Deno.test("бюджет шага исчерпан: доски пропущены, части 1 и 4 всё равно собраны", async () => {
  const fixtures = await loadGoldenFixtures();
  const boardCalls: string[] = [];
  const { baseUrl, stop } = fakeServer((req) => {
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
    // последующие вызовы (внутри collectBoardPart/kaitenGet) обязаны
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
    assertEquals(
      performance.now() - start < 200,
      true,
      "исчерпание бюджета не должно ждать реальное время",
    );

    assertEquals(warmup.lanes, null);
    assertEquals(warmup.columns, null);
    assertEquals(warmup.skips.length, 4); // 2 доски × 2 части (lanes, columns)
    for (const skip of warmup.skips) {
      assertEquals(skip.reason, "бюджет шага исчерпан");
    }
    // Части 1 и 4 не проверяют бюджет — собраны как обычно.
    assertEquals(warmup.spaces.length, 2);
    assertEquals(warmup.boards.length, 2);
    assertEquals(warmup.roles?.length, 2);
    // Ни один запрос доски не дошёл до сервера — бюджет остановил его
    // раньше, чем ушёл HTTP-вызов.
    assertEquals(boardCalls, []);
  } finally {
    await stop();
  }
});

// --- секреты -------------------------------------------------------------------

Deno.test("API-ключ не появляется в текстах ошибок", async (t) => {
  await t.step("ошибка части 1 (не-2xx)", async () => {
    const { baseUrl, stop } = fakeServer(() =>
      new Response("nope", { status: 500 })
    );
    try {
      const err = await assertRejects(
        () => collectKaitenWarmup(accessTo(baseUrl), AMPLE_LIMITS),
        KaitenError,
      );
      assertEquals(err.message.includes(API_KEY), false);
      const causeText = err.cause instanceof Error
        ? err.cause.message
        : String(err.cause);
      assertEquals(causeText.includes(API_KEY), false);
      assertEquals((err.stack ?? "").includes(API_KEY), false);
    } finally {
      await stop();
    }
  });

  await t.step("skip доски: причина без ключа", async () => {
    const fixtures = await loadGoldenFixtures();
    const { baseUrl, stop } = fakeServer((req) => {
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
        assertEquals(skip.reason.includes(API_KEY), false);
      }
    } finally {
      await stop();
    }
  });

  await t.step("сетевой сбой (HttpCallError): причина без ключа", async () => {
    // Часть 1 и часть 4 идут двумя одновременными запросами — общий
    // "затвор" вместо общего `Response`: тело читается один раз, а сервер
    // отдаёт каждому запросу свежий объект (см. `portainer_test.ts`,
    // тест "гонка таймеров"). Общий `Response`-промис отдал бы один и тот
    // же поток телу второго запроса и упал бы "body already consumed".
    const gate = Promise.withResolvers<void>();
    const { baseUrl, stop } = fakeServer(async () => {
      await gate.promise;
      return new Response("[]");
    });
    try {
      const err = await assertRejects(
        () =>
          collectKaitenWarmup(accessTo(baseUrl), {
            timeouts: { headersTimeoutMs: 20, totalTimeoutMs: 200 },
            budgetMs: AMPLE_LIMITS.budgetMs,
          }),
        KaitenError,
      );
      assertEquals(err.message.includes(API_KEY), false);
    } finally {
      gate.resolve();
      await stop();
    }
  });
});

// --- requireKaitenAccess -----------------------------------------------------

Deno.test("requireKaitenAccess: ключ есть/пуст/отсутствует, дефолт и override базового URL", async (t) => {
  interface Case {
    readonly name: string;
    readonly apiKey: string | undefined;
    readonly baseUrl: string | undefined;
    readonly expected: KaitenAccess | "ошибка";
  }
  const cases: readonly Case[] = [
    {
      name: "ключ задан, базовый URL по умолчанию",
      apiKey: "k1",
      baseUrl: undefined,
      expected: { baseUrl: "https://btlz.kaiten.ru", apiKey: "k1" },
    },
    {
      name: "базовый URL переопределён, хвостовые / срезаны",
      apiKey: "k2",
      baseUrl: "https://kaiten.example.com///",
      expected: { baseUrl: "https://kaiten.example.com", apiKey: "k2" },
    },
    { name: "ключ пуст", apiKey: "", baseUrl: undefined, expected: "ошибка" },
    {
      name: "ключа нет",
      apiKey: undefined,
      baseUrl: undefined,
      expected: "ошибка",
    },
  ];
  for (const c of cases) {
    await t.step(c.name, () => {
      const envFile = {
        get: (name: string) => {
          if (name === "KITEN_API_KEY") return c.apiKey;
          if (name === "KITEN_BASE_URL") return c.baseUrl;
          return undefined;
        },
      };
      if (c.expected === "ошибка") {
        const err = assertThrows(
          () => requireKaitenAccess(envFile),
          KaitenError,
          "KITEN_API_KEY не задан",
        );
        assertEquals(err.message, "KITEN_API_KEY не задан");
      } else {
        assertEquals(requireKaitenAccess(envFile), c.expected);
      }
    });
  }
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

Deno.test("writeKaitenWarmup: полная замена spaces/boards/roles", async () => {
  await withBootstrappedDb((dbPath) => {
    using db = openCacheDb(dbPath);

    writeKaitenWarmup(db, {
      ...EMPTY_WARMUP,
      spaces: [{ id: 101, title: "Разработка", archived: false }],
      boards: [{ id: 501, spaceId: 101, title: "Основная доска" }],
      roles: [{ id: 11, name: "Разработка" }],
    }, 1_000);

    assertEquals(
      db.query("SELECT id, title, archived, discovered_at FROM kaiten_spaces"),
      [{ id: 101, title: "Разработка", archived: 0, discovered_at: 1_000 }],
    );
    assertEquals(
      db.query("SELECT id, space_id, title, discovered_at FROM kaiten_boards"),
      [{
        id: 501,
        space_id: 101,
        title: "Основная доска",
        discovered_at: 1_000,
      }],
    );
    assertEquals(
      db.query("SELECT id, name, discovered_at FROM kaiten_roles"),
      [{ id: 11, name: "Разработка", discovered_at: 1_000 }],
    );

    // Второй вызов с другим набором — старые строки не остаются
    // (полная замена, kaiten-http.md, «Побочные эффекты»).
    writeKaitenWarmup(db, {
      ...EMPTY_WARMUP,
      spaces: [{ id: 102, title: "Архив", archived: true }],
      boards: [],
      roles: [],
    }, 2_000);

    assertEquals(
      db.query("SELECT id, title, archived, discovered_at FROM kaiten_spaces"),
      [{ id: 102, title: "Архив", archived: 1, discovered_at: 2_000 }],
    );
    assertEquals(db.query("SELECT id FROM kaiten_boards"), []);
    assertEquals(db.query("SELECT id FROM kaiten_roles"), []);
  });
});

Deno.test("writeKaitenWarmup: scoped-замена дорожек — обойдённая доска заменена, необойдённая цела", async () => {
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

    writeKaitenWarmup(db, {
      ...EMPTY_WARMUP,
      lanes: {
        boardIds: [501],
        rows: [{ id: 9002, boardId: 501, title: "новая дорожка 501" }],
      },
    }, 2_000);

    assertEquals(
      db.query(
        "SELECT id, board_id, title, discovered_at FROM kaiten_lanes ORDER BY board_id, id",
      ),
      [
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
      ],
    );
  });
});

Deno.test("writeKaitenWarmup: lanes: null не трогает таблицу вовсе", async () => {
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

    assertEquals(
      db.query("SELECT id, board_id, title, discovered_at FROM kaiten_lanes"),
      [{
        id: 9001,
        board_id: 501,
        title: "дорожка до прогрева",
        discovered_at: 500,
      }],
    );
  });
});
