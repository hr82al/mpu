/**
 * Чтение записей эндпоинтом `query_range` (`docs/specs/logs.md`,
 * «Побочные эффекты»): форма запроса, сборка записей из всех элементов
 * `result`, терпимость к мусору в теле и различение отказов по типу.
 *
 * Фейковый сервер — та же калька, что в `loki_test.ts` и
 * `portainer_test.ts`: общего тестового модуля под неё нет намеренно.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { LokiError, LokiHttpError, queryRange } from "./mod.ts";

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

/** Запрос-образец: значения проверяются на стороне сервера-фейка. */
const QUERY = {
  logql: '{host="sl-1"} |= `боль`',
  startNs: 1_754_380_800_000_000_000n,
  endNs: 1_754_380_860_000_000_000n,
  limit: 200,
  direction: "backward",
} as const;

/** Ответ Loki с двумя потоками: записи собираются из обоих. */
const BODY = JSON.stringify({
  data: {
    result: [
      {
        stream: { host: "sl-1" },
        values: [["1754380800000000001", "первая"]],
      },
      {
        stream: { host: "sl-2" },
        values: [["1754380800000000002", "вторая\n"]],
      },
    ],
  },
});

Deno.test("запрос несёт LogQL, границы окна, лимит и направление", async () => {
  const seen: URL[] = [];
  const { baseUrl, stop } = fakeServer((req) => {
    seen.push(new URL(req.url));
    return new Response(BODY, { status: 200 });
  });
  try {
    const entries = await queryRange({ baseUrl }, QUERY);
    assertEquals(seen[0].pathname, "/loki/api/v1/query_range");
    assertEquals(seen[0].searchParams.get("query"), QUERY.logql);
    assertEquals(seen[0].searchParams.get("start"), "1754380800000000000");
    assertEquals(seen[0].searchParams.get("end"), "1754380860000000000");
    assertEquals(seen[0].searchParams.get("limit"), "200");
    assertEquals(seen[0].searchParams.get("direction"), "backward");
    assertEquals(entries, [
      { tsNs: "1754380800000000001", line: "первая" },
      { tsNs: "1754380800000000002", line: "вторая\n" },
    ]);
  } finally {
    await stop();
  }
});

Deno.test("мусор в теле: пропуск поштучно, а не отказ", async (t) => {
  const cases: readonly (readonly [string, string, number])[] = [
    ["тело не JSON", "не json", 0],
    ["верхний уровень не по схеме", JSON.stringify({ data: 42 }), 0],
    ["result не список", JSON.stringify({ data: { result: {} } }), 0],
    [
      "элемент result не по схеме — пропуск только его",
      JSON.stringify({
        data: {
          result: [
            "мусор",
            { values: "не список" },
            { values: [["1", "жива"]] },
          ],
        },
      }),
      1,
    ],
    [
      "негодные пары values пропускаются",
      JSON.stringify({
        data: {
          result: [{
            values: [
              "не массив",
              ["одна"],
              [1, "нестроковый ts"],
              ["не-целое", "строка"],
              ["2", 42],
              ["3", "жива", "лишнее"],
            ],
          }],
        },
      }),
      1,
    ],
  ];

  for (const [title, body, expected] of cases) {
    await t.step(title, async () => {
      const { baseUrl, stop } = fakeServer(() =>
        new Response(body, { status: 200 })
      );
      try {
        assertEquals((await queryRange({ baseUrl }, QUERY)).length, expected);
      } finally {
        await stop();
      }
    });
  }
});

Deno.test("ответ вне 2xx — LokiHttpError с кодом и телом", async () => {
  const { baseUrl, stop } = fakeServer(() =>
    new Response("  end timestamp must not be before start  ", { status: 400 })
  );
  try {
    const err = await assertRejects(
      () => queryRange({ baseUrl }, QUERY),
      LokiHttpError,
    );
    assertEquals(err.status, 400);
    assertEquals(err.body, "  end timestamp must not be before start  ");
  } finally {
    await stop();
  }
});

Deno.test("сетевой сбой — LokiError, а не отказ с кодом", async () => {
  const { baseUrl, stop } = fakeServer(() => new Response("", { status: 200 }));
  await stop();
  const err = await assertRejects(
    () => queryRange({ baseUrl }, QUERY),
    LokiError,
  );
  assertEquals(err instanceof LokiHttpError, false);
});
