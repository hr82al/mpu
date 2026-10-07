/**
 * Контракт запроса Kaiten (`docs/specs/platform/kaiten-http.md`, разделы
 * «Запрос» и «Retry и ошибки») на фейковом HTTP-сервере: методы помимо
 * GET с JSON-телом и заголовком типа содержимого, query-параметры,
 * пустое тело успешного ответа, пределы времени на каждом вызове, формат
 * ошибки не-2xx с настоящим методом и повтор 429 у мутирующего вызова.
 *
 * Прогрев справочников поверх того же транспорта проверяет
 * `kaiten.test.ts` — здесь только сам запрос, без единого вызова
 * каталогов по имени.
 *
 * Фейковый сервер — общий стенд модуля (`./testing.ts`). Паузы retry —
 * `Retry-After: 0`:
 * задержка вырождается в `setTimeout(0)`, а не «сон стеной»
 * (`ts/CLAUDE.md`).
 */

import { assert, describe, expect, it, vi } from "vitest";
import { rejected } from "../testing/thrown.ts";
import { type KaitenAccess, KaitenError } from "./mod.ts";
import {
  KAITEN_TIMEOUTS,
  kaitenCall,
  kaitenCallArray,
  kaitenCallCursorPaged,
  kaitenCallPaged,
} from "./http.ts";
import { startFakeKaiten } from "./testing.ts";

const API_KEY = "proba-kaiten-key-Q3z8Nw";

function accessTo(baseUrl: string): KaitenAccess {
  return { baseUrl, apiKey: API_KEY };
}

it("POST: метод, JSON-тело, Content-Type и разбор ответа", async () => {
  const { baseUrl, seen, stop } = await startFakeKaiten(() =>
    Response.json({ id: 7, comment: "ok" }, { status: 201 }),
  );
  try {
    const result = await kaitenCall(accessTo(baseUrl), {
      method: "POST",
      path: "/cards/42/time-logs",
      body: { for_date: "2026-07-20", time_spent: 90 },
    });

    expect(result).toStrictEqual({ id: 7, comment: "ok" });
    expect(seen.length).toBe(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].pathname).toBe("/api/latest/cards/42/time-logs");
    expect(seen[0].contentType).toBe("application/json");
    expect(seen[0].accept).toBe("application/json");
    expect(seen[0].authorization).toStrictEqual(`Bearer ${API_KEY}`);
    expect(JSON.parse(seen[0].body)).toStrictEqual({
      for_date: "2026-07-20",
      time_spent: 90,
    });
  } finally {
    await stop();
  }
});

it("вызов без тела не объявляет тип содержимого", async () => {
  const { baseUrl, seen, stop } = await startFakeKaiten(() =>
    Response.json([]),
  );
  try {
    await kaitenCallArray(accessTo(baseUrl), {
      method: "GET",
      path: "/user-roles",
    });

    expect(seen[0].method).toBe("GET");
    expect(seen[0].contentType).toStrictEqual(null);
    expect(seen[0].body).toBe("");
  } finally {
    await stop();
  }
});

it("query-параметры уходят в адрес запроса", async () => {
  const { baseUrl, seen, stop } = await startFakeKaiten(() =>
    Response.json([]),
  );
  try {
    await kaitenCallArray(accessTo(baseUrl), {
      method: "GET",
      path: "/users/9/time-logs",
      query: { from: "2026-07-01", to: "2026-07-31" },
    });

    expect(seen[0].pathname).toBe("/api/latest/users/9/time-logs");
    expect(seen[0].search).toBe("?from=2026-07-01&to=2026-07-31");
  } finally {
    await stop();
  }
});

describe("пустое тело успешного ответа — не ошибка разбора", () => {
  it("одиночный вызов: данных нет", async () => {
    const { baseUrl, stop } = await startFakeKaiten(
      () =>
        new Response(null, {
          status: 204,
        }),
    );
    try {
      expect(
        await kaitenCall(accessTo(baseUrl), {
          method: "DELETE",
          path: "/user-timers/5",
        }),
      ).toStrictEqual(undefined);
    } finally {
      await stop();
    }
  });

  it("вызов-список: пустой список", async () => {
    const { baseUrl, stop } = await startFakeKaiten(
      () =>
        new Response("", {
          status: 200,
        }),
    );
    try {
      expect(
        await kaitenCallArray(accessTo(baseUrl), {
          method: "GET",
          path: "/cards/42/time-logs",
        }),
      ).toStrictEqual([]);
    } finally {
      await stop();
    }
  });
});

it("не-2xx: текст ошибки называет метод и путь", async () => {
  const { baseUrl, stop } = await startFakeKaiten(
    () => new Response("boom", { status: 400 }),
  );
  try {
    const failure = kaitenCall(accessTo(baseUrl), {
      method: "PATCH",
      path: "/user-timers/5",
      body: { finished_at: null },
    });
    await expect(failure).rejects.toThrow(KaitenError);
    await expect(failure).rejects.toThrow(
      "kaiten PATCH /user-timers/5 -> 400: boom",
    );
  } finally {
    await stop();
  }
});

it("не-2xx с пустым телом: сообщение кончается кодом и двоеточием", async () => {
  // Недоступная карточка приходит как 403 без тела: существование чужой
  // карточки сервер не раскрывает (`kaiten-api-cards.md`, «Граничные
  // случаи»). Подставлять после двоеточия нечего, и заполнителя тут быть
  // не должно — иначе текст соврёт о том, что ответил сервер.
  const { baseUrl, stop } = await startFakeKaiten(
    () => new Response(null, { status: 403 }),
  );
  try {
    const err = await rejected(
      () =>
        kaitenCall(accessTo(baseUrl), {
          method: "GET",
          path: "/cards/99999999",
        }),
      KaitenError,
    );

    expect(err.message).toBe("kaiten GET /cards/99999999 -> 403: ");
  } finally {
    await stop();
  }
});

it("429 повторяется и у мутирующего вызова", async () => {
  const { baseUrl, seen, stop } = await startFakeKaiten((requests) =>
    requests.length === 1
      ? new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "0" },
        })
      : Response.json({ id: 11 }),
  );
  try {
    const notes: string[] = [];
    const result = await kaitenCall(
      accessTo(baseUrl),
      { method: "POST", path: "/user-timers", body: { card_id: 42 } },
      { notes },
    );

    expect(result).toStrictEqual({ id: 11 });
    expect(notes).toStrictEqual(["[kaiten] 429 rate-limit, sleep 0s"]);
    expect(seen.map((r) => r.method)).toStrictEqual(["POST", "POST"]);
    // Повтор несёт то же тело: 429 означает «запрос не обработан»
    // (`kaiten-http.md`, инварианты), поэтому повторяется он целиком.
    expect(seen.map((r) => r.body)).toStrictEqual([
      '{"card_id":42}',
      '{"card_id":42}',
    ]);
  } finally {
    await stop();
  }
});

it("пределы времени — на каждом вызове каталога", async () => {
  const pending = Promise.withResolvers<Response>();
  const { baseUrl, stop } = await startFakeKaiten(() => pending.promise);
  try {
    const start = performance.now();
    const failure = kaitenCall(
      accessTo(baseUrl),
      { method: "POST", path: "/user-timers", body: { card_id: 42 } },
      { timeouts: { headersTimeoutMs: 20, totalTimeoutMs: 500 } },
    );
    await expect(failure).rejects.toThrow(KaitenError);
    await expect(failure).rejects.toThrow("no response headers within 20ms");
    const elapsed = performance.now() - start;
    // Заведомо меньше totalTimeoutMs (500): сработал предел заголовков,
    // а не общий — и вызов вообще ограничен, а не ждёт бесконечно.
    expect(elapsed < 300, `elapsed ${elapsed}ms должно быть < 300ms`).toBe(
      true,
    );
  } finally {
    pending.resolve(new Response("{}"));
    await stop();
  }
});

/**
 * Kaiten, отдающий заголовки и начало тела, а остаток — только по
 * `finish()`: вызов, получивший заголовки, упирается в чтение тела, и
 * ограничивает его уже предел всего вызова. `stop` сперва отпускает тело —
 * иначе сервер ждал бы его вечно.
 */
async function stalledKaiten(
  head: string,
  tail: string,
): Promise<{
  readonly baseUrl: string;
  readonly finish: () => void;
  readonly stop: () => Promise<void>;
}> {
  const gate = Promise.withResolvers<void>();
  const encoder = new TextEncoder();
  const { baseUrl, stop } = await startFakeKaiten(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode(head));
            await gate.promise;
            controller.enqueue(encoder.encode(tail));
            controller.close();
          },
        }),
      ),
  );
  return {
    baseUrl,
    finish: () => gate.resolve(),
    stop: async () => {
      gate.resolve();
      await stop();
    },
  };
}

/**
 * Момент «клиент получил заголовки». Транспорт снимает таймер предела
 * заголовков ровно тогда, когда они пришли (`../http/mod.ts`), а приходят
 * они настоящим вводом-выводом: сдвиг поддельных часов раньше этого
 * момента сработал бы пределом заголовков, и тест покраснел бы не по
 * делу. Таймер узнаётся по сроку — первый, поставленный на
 * `headersTimeoutMs`, — поэтому неверная константа не превращает ожидание
 * в вечное.
 *
 * Ставится после `vi.useFakeTimers()` — обёртка ложится поверх поддельных
 * `setTimeout`/`clearTimeout` и снимается до `vi.useRealTimers()`;
 * дожидаться снятия таймера — до первого сдвига часов, иначе сдвиг
 * сработал бы пределом заголовков раньше, чем они пришли.
 */
function watchHeadersTimer(headersTimeoutMs: number): {
  readonly cleared: Promise<void>;
  [Symbol.dispose](): void;
} {
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const cleared = Promise.withResolvers<void>();
  type TimerId = ReturnType<typeof setTimeout>;
  let watched: TimerId | undefined;
  const watchedSet = (...args: Parameters<typeof setTimeout>): TimerId => {
    const id = set(...args);
    if (watched === undefined && args[1] === headersTimeoutMs) watched = id;
    return id;
  };
  // Приведение: `setTimeout` здесь типизирован по Node, с перегрузками, и
  // функция с одной сигнатурой им не равна.
  globalThis.setTimeout = watchedSet as unknown as typeof setTimeout;
  globalThis.clearTimeout = (id?: Parameters<typeof clearTimeout>[0]) => {
    if (id !== undefined && id === watched) cleared.resolve();
    clear(id);
  };
  return {
    cleared: cleared.promise,
    [Symbol.dispose]() {
      globalThis.setTimeout = set;
      globalThis.clearTimeout = clear;
    },
  };
}

describe("пределы Kaiten по умолчанию — свои, а не общие пределы транспорта", () => {
  // Время поддельное: пределы спеки — 15 с и 30 с, и ждать их стеной
  // тест не может (`ts/CLAUDE.md`). Запрос доходит до сервера настоящим
  // вводом-выводом, а таймеры пределов сдвигает `vi.advanceTimersByTimeAsync`.
  it("заголовки позже 3 с, но раньше 15 с — успех", async () => {
    const arrived = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<Response>();
    const { baseUrl, stop } = await startFakeKaiten(() => {
      arrived.resolve();
      return pending.promise;
    });
    try {
      vi.useFakeTimers();
      try {
        const call = kaitenCall(accessTo(baseUrl), {
          method: "GET",
          path: "/users/current",
        }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await arrived.promise;
        await vi.advanceTimersByTimeAsync(5_600);
        pending.resolve(Response.json({ id: 7 }));
        expect(await call).toStrictEqual({ value: { id: 7 } });
      } finally {
        vi.useRealTimers();
      }
    } finally {
      pending.resolve(Response.json({}));
      await stop();
    }
  });

  it("заголовков нет 15 с — отказ пределом Kaiten", async () => {
    // Часы сдвигаются за предел всего вызова: он срабатывает при любом
    // пределе заголовков, и слишком широкий предел даёт отказ с другим
    // сообщением (`no response within …`), а не вечное ожидание. Без
    // предела вызова сдвигать не за что — это само нарушение спеки.
    const total = KAITEN_TIMEOUTS.totalTimeoutMs;
    assert(total !== null, "у вызова Kaiten нет предела времени");
    const arrived = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<Response>();
    const { baseUrl, stop } = await startFakeKaiten(() => {
      arrived.resolve();
      return pending.promise;
    });
    try {
      vi.useFakeTimers();
      try {
        const call = kaitenCall(accessTo(baseUrl), {
          method: "GET",
          path: "/users/current",
        });
        const rejected = Promise.all([
          expect(call).rejects.toThrow(KaitenError),
          expect(call).rejects.toThrow("no response headers within 15000ms"),
        ]);
        await arrived.promise;
        await vi.advanceTimersByTimeAsync(total + 1);
        await rejected;
      } finally {
        vi.useRealTimers();
      }
    } finally {
      pending.resolve(Response.json({}));
      await stop();
    }
  });

  it("тело позже предела заголовков, но раньше предела вызова — успех", async () => {
    // Живость доказывается ответом, а не отсутствием отказа: отказ через
    // `node:http` доставляется не сразу, и промис, «ещё не отклонённый»
    // сразу после сдвига часов, мог быть уже обречён. Отменённый вызов
    // дочитанного тела не вернул бы.
    const { baseUrl, finish, stop } = await stalledKaiten('{"id":', "7}");
    try {
      vi.useFakeTimers();
      try {
        using watch = watchHeadersTimer(KAITEN_TIMEOUTS.headersTimeoutMs);
        const call = kaitenCall(accessTo(baseUrl), {
          method: "GET",
          path: "/users/current",
        }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await Promise.race([watch.cleared, call]);
        await vi.advanceTimersByTimeAsync(KAITEN_TIMEOUTS.headersTimeoutMs + 1);
        finish();
        expect(await call).toStrictEqual({ value: { id: 7 } });
      } finally {
        vi.useRealTimers();
      }
    } finally {
      await stop();
    }
  });

  it("тело не приходит — отказ пределом вызова 30 с", async () => {
    // Часы — за верхнюю из двух границ, спеки и константы: неверный предел
    // вызова даёт отказ с другим числом за миллисекунды, а не ожидание, до
    // которого часы не дошли. Без предела вызова сдвигать не за что.
    const total = KAITEN_TIMEOUTS.totalTimeoutMs;
    assert(total !== null, "у вызова Kaiten нет предела времени");
    const { baseUrl, stop } = await stalledKaiten('{"id":', "7}");
    try {
      vi.useFakeTimers();
      try {
        using watch = watchHeadersTimer(KAITEN_TIMEOUTS.headersTimeoutMs);
        const call = kaitenCall(accessTo(baseUrl), {
          method: "GET",
          path: "/users/current",
        }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await Promise.race([watch.cleared, call]);
        await vi.advanceTimersByTimeAsync(Math.max(total, 30_000) + 1);
        const outcome = await call;
        assert(
          "error" in outcome,
          `вызов не отказал: ${JSON.stringify(outcome)}`,
        );
        assert(outcome.error instanceof KaitenError, String(outcome.error));
        // Сообщение целиком, а не подстрокой: число предела — последнее в
        // строке, и сверка целиком не пропустит ни хвоста, ни префикса.
        expect(outcome.error.message).toBe("no response within 30000ms");
      } finally {
        vi.useRealTimers();
      }
    } finally {
      await stop();
    }
  });
});

/** Страница ровно в размер лимита: следом сервер обязан получить ещё запрос. */
function fullPage(): readonly number[] {
  return Array.from({ length: 100 }, (_, index) => index);
}

describe("offset-пагинация: страницы до первой короче лимита", () => {
  it("полная страница, затем неполная", async () => {
    const { baseUrl, seen, stop } = await startFakeKaiten((requests) =>
      Response.json(requests.length === 1 ? fullPage() : [100, 101]),
    );
    try {
      const items = await kaitenCallPaged(accessTo(baseUrl), {
        method: "GET",
        path: "/cards",
        query: { space_id: "42" },
      });

      // Сверяется весь список целиком, а не его длина: спека обещает
      // конкатенацию страниц ИМЕННО в порядке запросов.
      expect(items).toStrictEqual([...fullPage(), 100, 101]);
      // Фильтр вызывающего уходит на каждой странице, лимит и смещение
      // добавляет транспорт: 0, 100, … до неполной страницы.
      expect(seen.map((r) => r.search)).toStrictEqual([
        "?space_id=42&limit=100&offset=0",
        "?space_id=42&limit=100&offset=100",
      ]);
    } finally {
      await stop();
    }
  });

  it("полная страница, затем пустая", async () => {
    const { baseUrl, seen, stop } = await startFakeKaiten((requests) =>
      Response.json(requests.length === 1 ? fullPage() : []),
    );
    try {
      const items = await kaitenCallPaged(accessTo(baseUrl), {
        method: "GET",
        path: "/cards",
      });

      expect(items).toStrictEqual(fullPage());
      expect(seen.length).toBe(2);
    } finally {
      await stop();
    }
  });

  it("первая же страница неполная — один запрос", async () => {
    const { baseUrl, seen, stop } = await startFakeKaiten(() =>
      Response.json([7]),
    );
    try {
      expect(
        await kaitenCallPaged(accessTo(baseUrl), {
          method: "GET",
          path: "/cards",
        }),
      ).toStrictEqual([7]);
      expect(seen.length).toBe(1);
    } finally {
      await stop();
    }
  });
});

/** Путь ленты действий — единственный курсорный вызов (`kaiten-http.md`). */
const FEED_PATH = "/users/current/activities";

/** Страница ленты: курсор следующего запроса берётся с последнего элемента. */
function feedPage(count: number, created: string, prefix: string): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    created,
  }));
}

it("курсорная пагинация: курсор последнего элемента уходит следующим запросом", async () => {
  const first = feedPage(100, "2026-07-20T10:00:00.000Z", "p1");
  const second = [{ id: "p2-0", created: "2026-07-19T10:00:00.000Z" }];
  const { baseUrl, seen, stop } = await startFakeKaiten((requests) =>
    Response.json(requests.length === 1 ? first : second),
  );
  try {
    const items = await kaitenCallCursorPaged(
      accessTo(baseUrl),
      {
        method: "GET",
        path: FEED_PATH,
        query: { actions: "card_move,card_add" },
      },
      { maxPages: 5 },
    );

    // Сверяется весь список целиком, а не его длина: спека обещает
    // конкатенацию страниц ИМЕННО в порядке чтения.
    expect(items).toStrictEqual([...first, ...second]);
    // На первой странице курсор уходит пустыми строками — не опускается:
    // пустой курсор сервер трактует как «начать сначала».
    expect(seen.map((r) => r.search)).toStrictEqual([
      "?actions=card_move%2Ccard_add&offset=0&limit=100" +
        "&cursor_created=&cursor_id=",
      "?actions=card_move%2Ccard_add&offset=0&limit=100" +
        "&cursor_created=2026-07-20T10%3A00%3A00.000Z&cursor_id=p1-99",
    ]);
  } finally {
    await stop();
  }
});

describe("курсорная пагинация: останов", () => {
  const full = feedPage(100, "2026-07-20T10:00:00.000Z", "p");

  it("страница короче лимита", async () => {
    const { baseUrl, seen, stop } = await startFakeKaiten((requests) =>
      Response.json(requests.length === 1 ? full : []),
    );
    try {
      const items = await kaitenCallCursorPaged(
        accessTo(baseUrl),
        { method: "GET", path: FEED_PATH },
        { maxPages: 5 },
      );

      expect(items).toStrictEqual(full);
      expect(seen.length).toBe(2);
    } finally {
      await stop();
    }
  });

  it("потолок страниц исчерпан", async () => {
    const { baseUrl, seen, stop } = await startFakeKaiten(() =>
      Response.json(full),
    );
    try {
      const items = await kaitenCallCursorPaged(
        accessTo(baseUrl),
        { method: "GET", path: FEED_PATH },
        { maxPages: 2 },
      );

      expect(items.length).toBe(200);
      expect(seen.length).toBe(2);
    } finally {
      await stop();
    }
  });

  it("у последнего элемента нет `created`", async () => {
    const tail = [
      ...feedPage(99, "2026-07-20T10:00:00.000Z", "p"),
      {
        id: "p-99",
        created: null,
      },
    ];
    const { baseUrl, seen, stop } = await startFakeKaiten(() =>
      Response.json(tail),
    );
    try {
      const items = await kaitenCallCursorPaged(
        accessTo(baseUrl),
        { method: "GET", path: FEED_PATH },
        { maxPages: 5 },
      );

      expect(items).toStrictEqual(tail);
      expect(seen.length).toBe(1);
    } finally {
      await stop();
    }
  });

  for (const [name, last] of [
    [
      "у последнего элемента нет `id`",
      {
        created: "2026-07-20T10:00:00.000Z",
      },
    ],
    ["последний элемент вообще не объект", "мусор"],
  ] as const) {
    it(name, async () => {
      const tail = [...feedPage(99, "2026-07-20T10:00:00.000Z", "p"), last];
      const { baseUrl, seen, stop } = await startFakeKaiten(() =>
        Response.json(tail),
      );
      try {
        const items = await kaitenCallCursorPaged(
          accessTo(baseUrl),
          { method: "GET", path: FEED_PATH },
          { maxPages: 5 },
        );

        expect(items).toStrictEqual(tail);
        expect(seen.length).toBe(1);
      } finally {
        await stop();
      }
    });
  }
});

describe("курсорная пагинация: нижняя граница даты", () => {
  const first = feedPage(100, "2026-07-20T10:00:00.000Z", "p1");
  const second = feedPage(100, "2026-07-10T10:00:00.000Z", "p2");
  const serveFeed = () =>
    startFakeKaiten((requests) =>
      Response.json(
        requests.length === 1 ? first : requests.length === 2 ? second : [],
      ),
    );

  it("`created` последнего стал меньше границы — останов", async () => {
    const { baseUrl, seen, stop } = await serveFeed();
    try {
      const items = await kaitenCallCursorPaged(
        accessTo(baseUrl),
        { method: "GET", path: FEED_PATH },
        { maxPages: 5, minCreated: "2026-07-15T00:00:00.000Z" },
      );

      // Прочитанная страница отдаётся целиком: серверного фильтра по дате
      // нет, а порт по границе только останавливается — элементы старше
      // неё из уже прочитанной страницы не отсеиваются.
      expect(items).toStrictEqual([...first, ...second]);
      expect(seen.length).toBe(2);
    } finally {
      await stop();
    }
  });

  it("`created` равен границе — обход продолжается", async () => {
    const { baseUrl, seen, stop } = await serveFeed();
    try {
      const items = await kaitenCallCursorPaged(
        accessTo(baseUrl),
        { method: "GET", path: FEED_PATH },
        { maxPages: 5, minCreated: "2026-07-10T10:00:00.000Z" },
      );

      expect(items.length).toBe(200);
      expect(seen.length).toBe(3);
    } finally {
      await stop();
    }
  });
});

it("тело multipart/form-data: граница своя на каждый запрос", async () => {
  const { baseUrl, seen, stop } = await startFakeKaiten(() =>
    Response.json({ id: 3 }),
  );
  try {
    for (const text of ["первый", "второй"]) {
      await kaitenCall(accessTo(baseUrl), {
        method: "POST",
        path: "/cards/42/comments",
        form: [{ kind: "field", name: "text", value: text }],
      });
    }

    const boundaries = seen.map((request) => {
      const contentType = request.contentType ?? "";
      expect(
        contentType.startsWith("multipart/form-data; boundary="),
        `тип содержимого не объявляет границу: ${contentType}`,
      ).toBe(true);
      return contentType.slice("multipart/form-data; boundary=".length);
    });

    // Тело собрано вокруг объявленной границы, а сама она на каждый
    // запрос своя (`kaiten-http.md`, «Запрос»).
    expect(seen[0].body).toStrictEqual(
      [
        `--${boundaries[0]}`,
        'Content-Disposition: form-data; name="text"',
        "",
        "первый",
        `--${boundaries[0]}--`,
      ].join("\r\n"),
    );
    expect(boundaries[0] === boundaries[1], "граница повторилась").toBe(false);
  } finally {
    await stop();
  }
});

it("ответ не той формы: вызов-список отказывает, а не пустеет", async () => {
  const { baseUrl, stop } = await startFakeKaiten(() =>
    Response.json({ id: 1 }),
  );
  try {
    const failure = kaitenCallArray(accessTo(baseUrl), {
      method: "GET",
      path: "/cards/42/time-logs",
    });
    await expect(failure).rejects.toThrow(KaitenError);
    await expect(failure).rejects.toThrow(
      "kaiten GET /cards/42/time-logs: ответ не JSON-массив",
    );
  } finally {
    await stop();
  }
});
