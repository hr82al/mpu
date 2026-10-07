/**
 * Клиент Portainer API (`docs/specs/init.md`, шаг 2) на фейковом
 * HTTP-сервере: happy path обоих вызовов, HTTP-код вне 2xx, оба
 * предела таймаута, отсутствие API-ключа в тексте ошибки. TLS-путь
 * (отключённая проверка сертификата) — отдельный файл
 * `portainer_tls.test.ts`: ему нужен сертификат, а прочим сценариям он
 * только шумит.
 *
 * Таймауты в сценариях таймаута — маленькие числа через параметр
 * `timeouts` у `listEndpoints`, не реальные секунды: фейковый сервер держит
 * ответ на промисе, который тест резолвит сам в `finally` (сон стеной
 * запрещён, CLAUDE.md).
 */

import { describe, expect, it, vi } from "vitest";
import { fakeTimers } from "../testing/scope.ts";
import { serveFetch } from "../testing/http.ts";
import { rejected } from "../testing/thrown.ts";
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

function accessTo(baseUrl: string): PortainerAccess {
  return { baseUrl, apiKey: API_KEY, verifyTls: true };
}

it("happy path: список endpoints и контейнеров, заголовок X-API-Key доходит", async () => {
  const seenKeys: string[] = [];
  const { baseUrl, stop } = await serveFetch((req) => {
    seenKeys.push(req.headers.get("X-API-Key") ?? "");
    const url = new URL(req.url);
    if (url.pathname === "/api/endpoints") {
      return Response.json([
        { Id: 1, Name: "prod", Status: 1 },
        { Id: 2, Name: "stage", Status: 1 },
      ]);
    }
    if (url.pathname === "/api/endpoints/1/docker/containers/json") {
      expect(url.searchParams.get("all")).toBe("true");
      return Response.json([
        {
          Id: "abc123",
          Status: "Up 3 days",
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
    expect(endpoints).toStrictEqual([
      { id: 1, name: "prod", status: 1 },
      {
        id: 2,
        name: "stage",
        status: 1,
      },
    ]);

    const containers = await listContainers(access, 1);
    expect(containers).toStrictEqual([
      {
        id: "abc123",
        names: ["/sl-3-cli"],
        state: "running",
        status: "Up 3 days",
        image: "img:tag",
      },
    ]);

    expect(seenKeys).toStrictEqual([API_KEY, API_KEY]);
  } finally {
    await stop();
  }
});

it("HTTP вне 2xx: причина одной строкой, ключ не в тексте ошибки", async () => {
  const { baseUrl, stop } = await serveFetch(
    () =>
      new Response("upstream is on fire\nsecond line noise", { status: 502 }),
  );
  try {
    const access = accessTo(baseUrl);
    const err = await rejected(
      () => listEndpoints(access),
      PortainerError,
      "HTTP 502",
    );
    expect(err.message).toBe("HTTP 502");
    expect(err.message.includes("\n")).toBe(false);
    expect(String(err).includes(API_KEY)).toBe(false);
  } finally {
    await stop();
  }
});

it("API-ключ не появляется ни в сообщении, ни в cause ошибки", async () => {
  const { baseUrl, stop } = await serveFetch(
    () => new Response("nope", { status: 500 }),
  );
  try {
    const access = accessTo(baseUrl);
    const err = await rejected(() => listEndpoints(access), PortainerError);
    const causeText =
      err.cause instanceof Error ? err.cause.message : String(err.cause);
    expect(err.message.includes(API_KEY)).toBe(false);
    expect(causeText.includes(API_KEY)).toBe(false);
    expect((err.stack ?? "").includes(API_KEY)).toBe(false);
  } finally {
    await stop();
  }
});

it("молчащий сервер: таймаут заголовков не дольше своего предела", async () => {
  const pending = Promise.withResolvers<Response>();
  const { baseUrl, stop } = await serveFetch(() => pending.promise);
  try {
    const access = accessTo(baseUrl);
    const start = performance.now();
    const err = await rejected(
      () =>
        listEndpoints(access, {
          headersTimeoutMs: 20,
          totalTimeoutMs: 500,
        }),
      PortainerError,
      "no response headers within 20ms",
    );
    const elapsed = performance.now() - start;
    expect(err.message).toBe("no response headers within 20ms");
    // Заведомо меньше totalTimeoutMs (500) — таймаут заголовков не ждал
    // общего предела.
    expect(elapsed < 300, `elapsed ${elapsed}ms должно быть < 300ms`).toBe(
      true,
    );
  } finally {
    pending.resolve(new Response("[]"));
    await stop();
  }
});

it("молчащий сервер: таймаут тела не дольше общего предела", async () => {
  const bodyGate = Promise.withResolvers<void>();
  const { baseUrl, stop } = await serveFetch(() => {
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
    const err = await rejected(
      () =>
        listEndpoints(access, {
          headersTimeoutMs: 500,
          totalTimeoutMs: 30,
        }),
      PortainerError,
      "no response within 30ms",
    );
    const elapsed = performance.now() - start;
    expect(err.message).toBe("no response within 30ms");
    expect(elapsed < 300, `elapsed ${elapsed}ms должно быть < 300ms`).toBe(
      true,
    );
  } finally {
    bodyGate.resolve();
    await stop();
  }
});

it("гонка таймеров: причину называет тот предел, что сработал первым", async () => {
  // Порядок событий, а не длительности: под нагрузкой реальные таймеры
  // в 1 мс друг от друга сходятся, и красноту давал планировщик, а не
  // починяемая ошибка. С поддельным временем срабатывания разведены
  // явно — сначала предел заголовков, следом общий.
  fakeTimers();
  const gate = Promise.withResolvers<void>();
  const { baseUrl, stop } = await serveFetch(async () => {
    await gate.promise;
    return new Response("[]");
  });
  try {
    const call = rejected(
      () =>
        listEndpoints(accessTo(baseUrl), {
          headersTimeoutMs: 50,
          totalTimeoutMs: 51,
        }),
      PortainerError,
    );
    // Один тик на оба предела, синхронный: колбэки идут подряд, и
    // обработка отказа между ними не вклинивается — ровно та
    // одновременность, из-за которой второй таймер переписывал причину
    // первого. Раздельные `tickAsync` эту гонку не воспроизводят:
    // первый отказ успевает отработать целиком и снять второй таймер.
    vi.advanceTimersByTime(51);
    const err = await call;
    expect(err.message).toBe("no response headers within 50ms");
  } finally {
    gate.resolve();
    await stop();
  }
});

it("мусор в полях ответа не роняет разбор", async () => {
  const { baseUrl, stop } = await serveFetch(() =>
    Response.json([
      { Id: "a", Names: ["/mp-sl-1-cli"], State: 5, Status: null, Image: {} },
      { Id: "b", Names: null, State: "running", Status: "Up", Image: "img" },
    ]),
  );
  try {
    // Живой ответ фермы приходит как есть, и падать на нём команде
    // незачем: не-строка равнозначна пустому значению, не-массив имён —
    // пустому списку.
    expect(await listContainers(accessTo(baseUrl), 1)).toStrictEqual([
      {
        id: "a",
        names: ["/mp-sl-1-cli"],
        state: "",
        status: "",
        image: "",
      },
      { id: "b", names: [], state: "running", status: "Up", image: "img" },
    ]);
  } finally {
    await stop();
  }
});

it("предела нет: запрос не рвётся сам собой", async () => {
  // `null` — именно отсутствие предела, а не огромное число:
  // `setTimeout` не принимает значений шире int32 и схлопывает их в
  // одну миллисекунду, то есть «бесконечный» предел срабатывал бы
  // мгновенно (`specs/health.md`: у запроса логов предела чтения нет).
  fakeTimers();
  const gate = Promise.withResolvers<void>();
  const { baseUrl, stop } = await serveFetch(async () => {
    await gate.promise;
    return new Response("[]");
  });
  try {
    const call = listEndpoints(accessTo(baseUrl), {
      headersTimeoutMs: 50,
      totalTimeoutMs: null,
    });
    // Одной миллисекунды хватает: огромное число вместо `null`
    // схлопывается таймером ровно в неё, и вызов оборвался бы здесь.
    // С отсутствием предела рвать нечего — ответ приходит, когда его
    // отдаст сервер.
    await vi.advanceTimersByTimeAsync(1);
    gate.resolve();
    expect(await call).toStrictEqual([]);
  } finally {
    gate.resolve();
    await stop();
  }
});

it("огромный предел вместо `null` — отказ, а не мгновенный обрыв", async () => {
  const { baseUrl, stop } = await serveFetch(() => new Response("[]"));
  try {
    // Таймер схлопнул бы такое значение в одну миллисекунду, и вызов
    // рвался бы сразу, выглядя сетевым сбоем. Сказать «предела нет»
    // можно только `null`.
    await rejected(
      () =>
        listEndpoints(accessTo(baseUrl), {
          headersTimeoutMs: 50,
          totalTimeoutMs: Number.MAX_SAFE_INTEGER,
        }),
      PortainerError,
      "не выражается таймером",
    );
  } finally {
    await stop();
  }
});

it("listContainers строит путь эндпоинта с ?all=true", async () => {
  let seenPath = "";
  const { baseUrl, stop } = await serveFetch((req) => {
    seenPath = new URL(req.url).pathname + new URL(req.url).search;
    return Response.json([]);
  });
  try {
    await listContainers(accessTo(baseUrl), 42);
    expect(seenPath).toContain("/api/endpoints/42/docker/containers/json");
    expect(seenPath).toContain("all=true");
  } finally {
    await stop();
  }
});

describe("firstLine: причина — только первая строка сообщения", () => {
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
    it(name, () => {
      expect(firstLine(input)).toStrictEqual(expected);
    });
  }
});

describe("логи контейнера: байты как есть и отказы своим классом", () => {
  const body = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 3, 200, 201, 202]);

  it("тело возвращается байтами, не текстом", async () => {
    const { baseUrl, stop } = await serveFetch(
      () => new Response(body, { status: 200 }),
    );
    try {
      // Байты 200–202 — не UTF-8: декодирование подменило бы их
      // символом-заменителем, и заголовки кадров перестали бы читаться.
      expect(
        await fetchContainerLogs(accessTo(baseUrl), 4, "mp-api", LOGS_QUERY),
      ).toStrictEqual(body);
    } finally {
      await stop();
    }
  });

  it("ответ вне 2xx — PortainerError с кодом", async () => {
    const { baseUrl, stop } = await serveFetch(
      () => new Response("no such container", { status: 404 }),
    );
    try {
      const err = await rejected(
        () => fetchContainerLogs(accessTo(baseUrl), 4, "mp-api", LOGS_QUERY),
        PortainerError,
      );
      expect(err.message).toBe("HTTP 404");
    } finally {
      await stop();
    }
  });

  it("сетевой сбой — та же ошибка одной строкой", async () => {
    const { baseUrl, stop } = await serveFetch(
      () => new Response("", { status: 200 }),
    );
    await stop();
    const err = await rejected(
      () => fetchContainerLogs(accessTo(baseUrl), 4, "mp-api", LOGS_QUERY),
      PortainerError,
    );
    expect(err.message.includes("\n")).toBe(false);
  });
});
