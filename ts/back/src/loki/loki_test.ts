/**
 * Клиент Loki (`docs/specs/platform/loki-http.md`) на фейковом HTTP-сервере:
 * happy path на golden-ответе `series-ok.json`, форма запроса (границы окна
 * в целых наносекундах), пустой результат на неожиданной форме ответа
 * (это явное поведение спеки, не ошибка), разбор записей (пропуск без
 * `host`, дедупликация), HTTP вне 2xx, таймаут молчащего сервера,
 * `requireLokiAccess` и полная перезапись кэша `writeLokiCache` поверх
 * настоящей SQLite-БД.
 *
 * Фейковый сервер — калька вспомогательной функции `portainer_test.ts`
 * (`Deno.serve({ port: 0 })` на петле); общего тестового модуля под неё нет
 * (те же причины дублирования, что у `cmd_init_test.ts`, YAGNI).
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { openCacheDb } from "../store/mod.ts";
import {
  collectLokiSeries,
  type LokiAccess,
  LokiError,
  requireLokiAccess,
  writeLokiCache,
} from "./mod.ts";

/** Поднимает фейковый Loki на петле; гасить `await stop()` в `finally`. */
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

function accessTo(baseUrl: string): LokiAccess {
  return { baseUrl };
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

// Сверку копии `testdata/series-ok.json` с каналом спецификаций держит
// `fixtures_test.ts` — там же, где сверка остальных копий модуля: два
// места одной проверки разошлись бы при добавлении третьей фикстуры.

Deno.test("happy path: golden-ответ даёт 4 хоста и 4 пары", async () => {
  const fixture = await Deno.readTextFile(
    new URL("testdata/series-ok.json", import.meta.url),
  );
  const { baseUrl, stop } = fakeServer(() =>
    new Response(fixture, {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  try {
    const series = await collectLokiSeries(accessTo(baseUrl));
    assertEquals(series.hosts, ["sl-1", "sl-2", "wb-1", "dt-1"]);
    assertEquals(series.pairs, [
      { host: "sl-1", service: "api" },
      { host: "sl-1", service: "wb-loader" },
      { host: "sl-2", service: "api" },
      { host: "wb-1", service: "wb-loader-app" },
    ]);
  } finally {
    await stop();
  }
});

Deno.test("форма запроса: путь, match[], границы окна в целых наносекундах", async () => {
  let seenUrl: URL | undefined;
  const { baseUrl, stop } = fakeServer((req) => {
    seenUrl = new URL(req.url);
    return Response.json({ data: [] });
  });
  try {
    // Момент с не-нулевыми миллисекундами: любое промежуточное
    // вычисление границы в `Number` (значение около 1.7e18 — далеко за
    // `Number.MAX_SAFE_INTEGER`) теряет младшие разряды, и Loki получает
    // не то окно. Проверяются и точные цифры, и то, что запись целая:
    // дробь или экспонента тоже сломали бы параметр.
    const nowMs = 1_735_689_600_123;
    await collectLokiSeries(accessTo(baseUrl), undefined, nowMs);

    if (seenUrl === undefined) throw new Error("запрос не дошёл до сервера");
    assertEquals(seenUrl.pathname, "/loki/api/v1/series");
    assertEquals(seenUrl.searchParams.get("match[]"), '{host=~".+"}');

    const start = seenUrl.searchParams.get("start");
    const end = seenUrl.searchParams.get("end");
    if (start === null || end === null) {
      throw new Error("start/end отсутствуют в запросе");
    }
    // Целые без экспоненты и дроби: `Number(...)` тут же обнажил бы обе
    // порчи формата, поэтому проверка на паттерн, а не только на значение.
    assertEquals(/^\d+$/.test(start), true, `start не целое: ${start}`);
    assertEquals(/^\d+$/.test(end), true, `end не целое: ${end}`);
    assertEquals(end, `${nowMs}000000`);
    assertEquals(start, `${nowMs - 86_400_000}000000`);
    assertEquals(BigInt(end) - BigInt(start), 86_400_000_000_000n);
  } finally {
    await stop();
  }
});

Deno.test("неожиданная форма ответа — пустой результат, не ошибка", async (t) => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["без data", JSON.stringify({ status: "success" })],
    ["data не список", JSON.stringify({ data: "oops" })],
    ["data — объект, не список", JSON.stringify({ data: { host: "h" } })],
    ["тело не JSON", "точно не json{"],
  ];
  for (const [name, body] of cases) {
    await t.step(name, async () => {
      const { baseUrl, stop } = fakeServer(() => new Response(body));
      try {
        const series = await collectLokiSeries(accessTo(baseUrl));
        assertEquals(series, { hosts: [], pairs: [] });
      } finally {
        await stop();
      }
    });
  }
});

Deno.test("разбор записей: запись без пригодного host пропускается поштучно", async () => {
  // Спека называет пустым результатом ответ неожиданной ФОРМЫ (без
  // `data`, `data` не список, тело не JSON), а не список, в котором
  // одна запись негодна: там пропускается только она — иначе один
  // мусорный элемент обнулял бы весь прогрев.
  const body = JSON.stringify({
    data: [
      "не объект", // элемент-не-объект: host взять неоткуда
      null, // и null — тоже
      { compose_service: "orphan" }, // без host — вся запись пропускается
      { host: "", compose_service: "empty-host" }, // host пуст — пропускается
      { host: 42, compose_service: "non-string-host" }, // host не строка
      { host: "h1" }, // host учтён, пары нет
      { host: "h1", compose_service: "s1" }, // первое появление пары
      { host: "h1", compose_service: "s1" }, // дубликат пары
      { host: "h1" }, // дубликат host
    ],
  });
  const { baseUrl, stop } = fakeServer(() => new Response(body));
  try {
    const series = await collectLokiSeries(accessTo(baseUrl));
    assertEquals(series.hosts, ["h1"]);
    assertEquals(series.pairs, [{ host: "h1", service: "s1" }]);
  } finally {
    await stop();
  }
});

Deno.test("HTTP вне 2xx: LokiError с текстом HTTP 503", async () => {
  const { baseUrl, stop } = fakeServer(() =>
    new Response("upstream unavailable", { status: 503 })
  );
  try {
    const err = await assertRejects(
      () => collectLokiSeries(accessTo(baseUrl)),
      LokiError,
      "HTTP 503",
    );
    assertEquals(err.message, "HTTP 503");
  } finally {
    await stop();
  }
});

Deno.test("молчащий сервер: таймаут заголовков не дольше своего предела", async () => {
  const pending = Promise.withResolvers<Response>();
  const { baseUrl, stop } = fakeServer(() => pending.promise);
  try {
    const start = performance.now();
    const err = await assertRejects(
      () =>
        collectLokiSeries(accessTo(baseUrl), {
          headersTimeoutMs: 20,
          totalTimeoutMs: 500,
        }),
      LokiError,
      "no response headers within 20ms",
    );
    const elapsed = performance.now() - start;
    assertEquals(err.message, "no response headers within 20ms");
    // Заведомо меньше totalTimeoutMs (500) — таймаут заголовков не ждал
    // общего предела.
    assertEquals(
      elapsed < 300,
      true,
      `elapsed ${elapsed}ms должно быть < 300ms`,
    );
  } finally {
    pending.resolve(new Response("{}"));
    await stop();
  }
});

Deno.test("requireLokiAccess: ключ есть / пуст / отсутствует / с хвостовыми /", async (t) => {
  interface Case {
    readonly name: string;
    readonly value: string | undefined;
    readonly expected: LokiAccess | "ошибка";
  }
  const cases: readonly Case[] = [
    {
      name: "ключ задан",
      value: "http://loki.example.com",
      expected: { baseUrl: "http://loki.example.com" },
    },
    {
      name: "хвостовые / срезаны",
      value: "http://loki.example.com///",
      expected: { baseUrl: "http://loki.example.com" },
    },
    { name: "ключ пуст", value: "", expected: "ошибка" },
    { name: "ключа нет", value: undefined, expected: "ошибка" },
  ];
  for (const c of cases) {
    await t.step(c.name, () => {
      const envFile = {
        get: (name: string) => name === "LOKI_URL" ? c.value : undefined,
      };
      if (c.expected === "ошибка") {
        const err = assertThrows(
          () => requireLokiAccess(envFile),
          LokiError,
          "LOKI_URL не задан",
        );
        assertEquals(err.message, "LOKI_URL не задан");
      } else {
        assertEquals(requireLokiAccess(envFile), c.expected);
      }
    });
  }
});

Deno.test("writeLokiCache: полная перезапись обеих таблиц одной транзакцией", async () => {
  await withBootstrappedDb((dbPath) => {
    using db = openCacheDb(dbPath);

    writeLokiCache(db, {
      hosts: ["sl-1", "sl-2"],
      pairs: [{ host: "sl-1", service: "api" }],
    }, 1_000);

    assertEquals(
      db.query("SELECT host, discovered_at FROM loki_hosts ORDER BY host"),
      [
        { host: "sl-1", discovered_at: 1_000 },
        { host: "sl-2", discovered_at: 1_000 },
      ],
    );
    assertEquals(
      db.query(
        "SELECT host, service, discovered_at FROM loki_services_by_host ORDER BY host, service",
      ),
      [{ host: "sl-1", service: "api", discovered_at: 1_000 }],
    );

    // Второй вызов с другим набором — полная перезапись: старых строк не
    // остаётся (инвариант спеки, `platform/loki-http.md`, «Инварианты»).
    writeLokiCache(db, {
      hosts: ["wb-1"],
      pairs: [],
    }, 2_000);

    assertEquals(
      db.query("SELECT host, discovered_at FROM loki_hosts ORDER BY host"),
      [{ host: "wb-1", discovered_at: 2_000 }],
    );
    assertEquals(
      db.query(
        "SELECT host, service, discovered_at FROM loki_services_by_host",
      ),
      [],
    );
  });
});
