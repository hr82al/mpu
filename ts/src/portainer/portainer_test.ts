/**
 * Клиент Portainer API (`docs/specs/init.md`, шаг 2) на фейковом
 * HTTP-сервере: happy path обоих вызовов, HTTP-код вне 2xx, оба
 * предела таймаута, отсутствие API-ключа в тексте ошибки. TLS-путь
 * (отключённая проверка сертификата) — отдельный файл
 * `portainer_tls_test.ts`: ему нужен сертификат, а прочим сценариям он
 * только шумит.
 *
 * Таймауты в сценариях таймаута — маленькие числа через параметр
 * `timeouts` у `listEndpoints`, не реальные секунды: фейковый сервер держит
 * ответ на промисе, который тест резолвит сам в `finally` (сон стеной
 * запрещён, CLAUDE.md).
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { firstLine } from "../http/mod.ts";
import {
  type ContainerLogsQuery,
  fetchContainerLogs,
  listContainers,
  listEndpoints,
  type PortainerAccess,
  PortainerError,
} from "./mod.ts";

const API_KEY = "proba-portainer-key-K7x9Qz";

/** Запрос-образец снимка логов: значения проверяются в `sources_test.ts`. */
const LOGS_QUERY: ContainerLogsQuery = {
  stdout: true,
  stderr: true,
  tail: 200,
  timestamps: false,
};

/** Поднимает фейковый Portainer на петле; гасить `await stop()` в `finally`. */
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

function accessTo(baseUrl: string): PortainerAccess {
  return { baseUrl, apiKey: API_KEY, verifyTls: true };
}

Deno.test("happy path: список endpoints и контейнеров, заголовок X-API-Key доходит", async () => {
  const seenKeys: string[] = [];
  const { baseUrl, stop } = fakeServer((req) => {
    seenKeys.push(req.headers.get("X-API-Key") ?? "");
    const url = new URL(req.url);
    if (url.pathname === "/api/endpoints") {
      return Response.json([
        { Id: 1, Name: "prod", Status: 1 },
        { Id: 2, Name: "stage", Status: 1 },
      ]);
    }
    if (url.pathname === "/api/endpoints/1/docker/containers/json") {
      assertEquals(url.searchParams.get("all"), "true");
      return Response.json([
        {
          Id: "abc123",
          Names: ["/sl-3-cli"],
          State: "running",
          Image: "img:tag",
        },
      ]);
    }
    return new Response(null, { status: 404 });
  });
  try {
    const access = accessTo(baseUrl);
    const endpoints = await listEndpoints(access);
    assertEquals(endpoints, [{ id: 1, name: "prod", status: 1 }, {
      id: 2,
      name: "stage",
      status: 1,
    }]);

    const containers = await listContainers(access, 1);
    assertEquals(containers, [
      {
        id: "abc123",
        names: ["/sl-3-cli"],
        state: "running",
        image: "img:tag",
      },
    ]);

    assertEquals(seenKeys, [API_KEY, API_KEY]);
  } finally {
    await stop();
  }
});

Deno.test("HTTP вне 2xx: причина одной строкой, ключ не в тексте ошибки", async () => {
  const { baseUrl, stop } = fakeServer(() =>
    new Response("upstream is on fire\nsecond line noise", { status: 502 })
  );
  try {
    const access = accessTo(baseUrl);
    const err = await assertRejects(
      () => listEndpoints(access),
      PortainerError,
      "HTTP 502",
    );
    assertEquals(err.message, "HTTP 502");
    assertEquals(err.message.includes("\n"), false);
    assertEquals(String(err).includes(API_KEY), false);
  } finally {
    await stop();
  }
});

Deno.test("API-ключ не появляется ни в сообщении, ни в cause ошибки", async () => {
  const { baseUrl, stop } = fakeServer(() =>
    new Response("nope", { status: 500 })
  );
  try {
    const access = accessTo(baseUrl);
    const err = await assertRejects(
      () => listEndpoints(access),
      PortainerError,
    );
    const causeText = err.cause instanceof Error
      ? err.cause.message
      : String(err.cause);
    assertEquals(err.message.includes(API_KEY), false);
    assertEquals(causeText.includes(API_KEY), false);
    assertEquals((err.stack ?? "").includes(API_KEY), false);
  } finally {
    await stop();
  }
});

Deno.test("молчащий сервер: таймаут заголовков не дольше своего предела", async () => {
  const pending = Promise.withResolvers<Response>();
  const { baseUrl, stop } = fakeServer(() => pending.promise);
  try {
    const access = accessTo(baseUrl);
    const start = performance.now();
    const err = await assertRejects(
      () =>
        listEndpoints(access, {
          headersTimeoutMs: 20,
          totalTimeoutMs: 500,
        }),
      PortainerError,
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
    pending.resolve(new Response("[]"));
    await stop();
  }
});

Deno.test("молчащий сервер: таймаут тела не дольше общего предела", async () => {
  const bodyGate = Promise.withResolvers<void>();
  const { baseUrl, stop } = fakeServer(() => {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        await bodyGate.promise;
        controller.enqueue(new TextEncoder().encode("[]"));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  });
  try {
    const access = accessTo(baseUrl);
    const start = performance.now();
    const err = await assertRejects(
      () =>
        listEndpoints(access, {
          headersTimeoutMs: 500,
          totalTimeoutMs: 30,
        }),
      PortainerError,
      "no response within 30ms",
    );
    const elapsed = performance.now() - start;
    assertEquals(err.message, "no response within 30ms");
    assertEquals(
      elapsed < 300,
      true,
      `elapsed ${elapsed}ms должно быть < 300ms`,
    );
  } finally {
    bodyGate.resolve();
    await stop();
  }
});

Deno.test("гонка таймеров: причина стабильна при пределах вплотную (много прогонов)", async () => {
  // Общий "затвор" вместо общего Response: тело ответа читается один раз,
  // а тест шлёт много запросов — каждый вызов обработчика ждёт тот же
  // затвор, но отдаёт свежий Response.
  const gate = Promise.withResolvers<void>();
  const { baseUrl, stop } = fakeServer(async () => {
    await gate.promise;
    return new Response("[]");
  });
  try {
    const access = accessTo(baseUrl);
    // Пределы вплотную — 1ms между ними (50ms/51ms: делать саму базу
    // меньше в этом окружении опасно — при базе в единицы миллисекунд
    // порядок срабатывания реальных `setTimeout` под реальным сетевым
    // вводом-выводом сам по себе неустойчив вне зависимости от починяемой
    // ошибки и даёт ложную красноту; проверено отдельно сотнями
    // прогонов). Без гварда "уже сработал другой таймер" таймер общего
    // предела успевает переписать причину после того, как таймер
    // заголовков уже вызвал abort(), — сообщение флапает между
    // "no response headers…" и "no response…". Цикл в несколько
    // десятков прогонов внутри одного теста — иначе гонка не доказана
    // однократным совпадением.
    for (let i = 0; i < 50; i++) {
      const err = await assertRejects(
        () =>
          listEndpoints(access, {
            headersTimeoutMs: 50,
            totalTimeoutMs: 51,
          }),
        PortainerError,
      );
      assertEquals(
        err.message,
        "no response headers within 50ms",
        `прогон ${i}: причина обязана называть предел заголовков, а не общий`,
      );
    }
  } finally {
    gate.resolve();
    await stop();
  }
});

Deno.test("listContainers строит путь эндпоинта с ?all=true", async () => {
  let seenPath = "";
  const { baseUrl, stop } = fakeServer((req) => {
    seenPath = new URL(req.url).pathname + new URL(req.url).search;
    return Response.json([]);
  });
  try {
    await listContainers(accessTo(baseUrl), 42);
    assertStringIncludes(seenPath, "/api/endpoints/42/docker/containers/json");
    assertStringIncludes(seenPath, "all=true");
  } finally {
    await stop();
  }
});

Deno.test("firstLine: причина — только первая строка сообщения", async (t) => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["без переноса строки", "connection reset", "connection reset"],
    [
      "многострочное сообщение (вторая строка — подсказка MDN)",
      "NetworkError when attempting to fetch resource.\n" +
      "See https://developer.mozilla.org/... for more information.",
      "NetworkError when attempting to fetch resource.",
    ],
  ];
  for (const [name, input, expected] of cases) {
    await t.step(name, () => {
      assertEquals(firstLine(input), expected);
    });
  }
});

Deno.test("логи контейнера: байты как есть и отказы своим классом", async (t) => {
  const body = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 3, 200, 201, 202]);

  await t.step("тело возвращается байтами, не текстом", async () => {
    const { baseUrl, stop } = fakeServer(() =>
      new Response(body, { status: 200 })
    );
    try {
      // Байты 200–202 — не UTF-8: декодирование подменило бы их
      // символом-заменителем, и заголовки кадров перестали бы читаться.
      assertEquals(
        await fetchContainerLogs(accessTo(baseUrl), 4, "mp-api", LOGS_QUERY),
        body,
      );
    } finally {
      await stop();
    }
  });

  await t.step("ответ вне 2xx — PortainerError с кодом", async () => {
    const { baseUrl, stop } = fakeServer(() =>
      new Response("no such container", { status: 404 })
    );
    try {
      const err = await assertRejects(
        () => fetchContainerLogs(accessTo(baseUrl), 4, "mp-api", LOGS_QUERY),
        PortainerError,
      );
      assertEquals(err.message, "HTTP 404");
    } finally {
      await stop();
    }
  });

  await t.step("сетевой сбой — та же ошибка одной строкой", async () => {
    const { baseUrl, stop } = fakeServer(() =>
      new Response("", { status: 200 })
    );
    await stop();
    const err = await assertRejects(
      () => fetchContainerLogs(accessTo(baseUrl), 4, "mp-api", LOGS_QUERY),
      PortainerError,
    );
    assertEquals(err.message.includes("\n"), false);
  });
});
