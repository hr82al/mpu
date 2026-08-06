/**
 * Контракт запроса Kaiten (`docs/specs/platform/kaiten-http.md`, разделы
 * «Запрос» и «Retry и ошибки») на фейковом HTTP-сервере: методы помимо
 * GET с JSON-телом и заголовком типа содержимого, query-параметры,
 * пустое тело успешного ответа, пределы времени на каждом вызове, формат
 * ошибки не-2xx с настоящим методом и повтор 429 у мутирующего вызова.
 *
 * Прогрев справочников поверх того же транспорта проверяет
 * `kaiten_test.ts` — здесь только сам запрос, без единого вызова
 * каталогов по имени.
 *
 * Фейковый сервер — калька `kaiten_test.ts`/`portainer_test.ts`
 * (`Deno.serve({ port: 0 })` на петле). Паузы retry — `Retry-After: 0`:
 * задержка вырождается в `setTimeout(0)`, а не «сон стеной»
 * (`ts/CLAUDE.md`).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { type KaitenAccess, KaitenError } from "./mod.ts";
import { kaitenCall, kaitenCallArray } from "./http.ts";

const API_KEY = "proba-kaiten-key-Q3z8Nw";

/** Запрос, как его увидел сервер: форма отправленного проверяется по ней. */
interface Captured {
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
  readonly contentType: string | null;
  readonly accept: string | null;
  readonly authorization: string | null;
  readonly body: string;
}

/**
 * Поднимает фейковый Kaiten на петле и складывает разобранные запросы в
 * `seen`; гасить `await stop()` в `finally`.
 */
function fakeServer(
  reply: (seen: readonly Captured[]) => Response | Promise<Response>,
): {
  readonly baseUrl: string;
  readonly seen: readonly Captured[];
  readonly stop: () => Promise<void>;
} {
  const seen: Captured[] = [];
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        pathname: url.pathname,
        search: url.search,
        contentType: req.headers.get("content-type"),
        accept: req.headers.get("accept"),
        authorization: req.headers.get("authorization"),
        body: await req.text(),
      });
      return reply(seen);
    },
  );
  return {
    baseUrl: `http://127.0.0.1:${server.addr.port}`,
    seen,
    stop: () => server.shutdown(),
  };
}

function accessTo(baseUrl: string): KaitenAccess {
  return { baseUrl, apiKey: API_KEY };
}

Deno.test("POST: метод, JSON-тело, Content-Type и разбор ответа", async () => {
  const { baseUrl, seen, stop } = fakeServer(() =>
    Response.json({ id: 7, comment: "ok" }, { status: 201 })
  );
  try {
    const result = await kaitenCall(accessTo(baseUrl), {
      method: "POST",
      path: "/cards/42/time-logs",
      body: { for_date: "2026-07-20", time_spent: 90 },
    });

    assertEquals(result, { id: 7, comment: "ok" });
    assertEquals(seen.length, 1);
    assertEquals(seen[0].method, "POST");
    assertEquals(seen[0].pathname, "/api/latest/cards/42/time-logs");
    assertEquals(seen[0].contentType, "application/json");
    assertEquals(seen[0].accept, "application/json");
    assertEquals(seen[0].authorization, `Bearer ${API_KEY}`);
    assertEquals(
      JSON.parse(seen[0].body),
      { for_date: "2026-07-20", time_spent: 90 },
    );
  } finally {
    await stop();
  }
});

Deno.test("вызов без тела не объявляет тип содержимого", async () => {
  const { baseUrl, seen, stop } = fakeServer(() => Response.json([]));
  try {
    await kaitenCallArray(accessTo(baseUrl), {
      method: "GET",
      path: "/user-roles",
    });

    assertEquals(seen[0].method, "GET");
    assertEquals(seen[0].contentType, null);
    assertEquals(seen[0].body, "");
  } finally {
    await stop();
  }
});

Deno.test("query-параметры уходят в адрес запроса", async () => {
  const { baseUrl, seen, stop } = fakeServer(() => Response.json([]));
  try {
    await kaitenCallArray(accessTo(baseUrl), {
      method: "GET",
      path: "/users/9/time-logs",
      query: { from: "2026-07-01", to: "2026-07-31" },
    });

    assertEquals(seen[0].pathname, "/api/latest/users/9/time-logs");
    assertEquals(seen[0].search, "?from=2026-07-01&to=2026-07-31");
  } finally {
    await stop();
  }
});

Deno.test("пустое тело успешного ответа — не ошибка разбора", async (t) => {
  await t.step("одиночный вызов: данных нет", async () => {
    const { baseUrl, stop } = fakeServer(() =>
      new Response(null, {
        status: 204,
      })
    );
    try {
      assertEquals(
        await kaitenCall(accessTo(baseUrl), {
          method: "DELETE",
          path: "/user-timers/5",
        }),
        undefined,
      );
    } finally {
      await stop();
    }
  });

  await t.step("вызов-список: пустой список", async () => {
    const { baseUrl, stop } = fakeServer(() =>
      new Response("", {
        status: 200,
      })
    );
    try {
      assertEquals(
        await kaitenCallArray(accessTo(baseUrl), {
          method: "GET",
          path: "/cards/42/time-logs",
        }),
        [],
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("не-2xx: текст ошибки называет метод и путь", async () => {
  const { baseUrl, stop } = fakeServer(() =>
    new Response("boom", { status: 400 })
  );
  try {
    await assertRejects(
      () =>
        kaitenCall(accessTo(baseUrl), {
          method: "PATCH",
          path: "/user-timers/5",
          body: { finished_at: null },
        }),
      KaitenError,
      "kaiten PATCH /user-timers/5 -> 400: boom",
    );
  } finally {
    await stop();
  }
});

Deno.test("429 повторяется и у мутирующего вызова", async () => {
  const { baseUrl, seen, stop } = fakeServer((requests) =>
    requests.length === 1
      ? new Response("slow down", {
        status: 429,
        headers: { "Retry-After": "0" },
      })
      : Response.json({ id: 11 })
  );
  try {
    const notes: string[] = [];
    const result = await kaitenCall(
      accessTo(baseUrl),
      { method: "POST", path: "/user-timers", body: { card_id: 42 } },
      { notes },
    );

    assertEquals(result, { id: 11 });
    assertEquals(notes, ["[kaiten] 429 rate-limit, sleep 0s"]);
    assertEquals(seen.map((r) => r.method), ["POST", "POST"]);
    // Повтор несёт то же тело: 429 означает «запрос не обработан»
    // (`kaiten-http.md`, инварианты), поэтому повторяется он целиком.
    assertEquals(seen.map((r) => r.body), [
      '{"card_id":42}',
      '{"card_id":42}',
    ]);
  } finally {
    await stop();
  }
});

Deno.test("пределы времени — на каждом вызове каталога", async () => {
  const pending = Promise.withResolvers<Response>();
  const { baseUrl, stop } = fakeServer(() => pending.promise);
  try {
    const start = performance.now();
    await assertRejects(
      () =>
        kaitenCall(
          accessTo(baseUrl),
          { method: "POST", path: "/user-timers", body: { card_id: 42 } },
          { timeouts: { headersTimeoutMs: 20, totalTimeoutMs: 500 } },
        ),
      KaitenError,
      "no response headers within 20ms",
    );
    const elapsed = performance.now() - start;
    // Заведомо меньше totalTimeoutMs (500): сработал предел заголовков,
    // а не общий — и вызов вообще ограничен, а не ждёт бесконечно.
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

Deno.test("ответ не той формы: вызов-список отказывает, а не пустеет", async () => {
  const { baseUrl, stop } = fakeServer(() => Response.json({ id: 1 }));
  try {
    await assertRejects(
      () =>
        kaitenCallArray(accessTo(baseUrl), {
          method: "GET",
          path: "/cards/42/time-logs",
        }),
      KaitenError,
      "kaiten GET /cards/42/time-logs: ответ не JSON-массив",
    );
  } finally {
    await stop();
  }
});
