/**
 * Чтение записей эндпоинтом `query_range` (`docs/specs/logs.md`,
 * «Побочные эффекты»): форма запроса, сборка записей из всех элементов
 * `result`, терпимость к мусору в теле и различение отказов по типу.
 *
 * Фейковый сервер — общий `serveFetch` (`@mpu/testing`).
 */

import { describe, expect, it } from "vitest";
import { serveFetch } from "@mpu/testing";
import { rejected } from "@mpu/testing/thrown";
import { LokiError, LokiHttpError, queryRange } from "./mod.ts";

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

it("запрос несёт LogQL, границы окна, лимит и направление", async () => {
  const seen: URL[] = [];
  const { baseUrl, stop } = await serveFetch((req) => {
    seen.push(new URL(req.url));
    return new Response(BODY, { status: 200 });
  });
  try {
    const entries = await queryRange({ baseUrl }, QUERY);
    expect(seen[0].pathname).toBe("/loki/api/v1/query_range");
    expect(seen[0].searchParams.get("query")).toStrictEqual(QUERY.logql);
    expect(seen[0].searchParams.get("start")).toBe("1754380800000000000");
    expect(seen[0].searchParams.get("end")).toBe("1754380860000000000");
    expect(seen[0].searchParams.get("limit")).toBe("200");
    expect(seen[0].searchParams.get("direction")).toBe("backward");
    expect(entries).toStrictEqual([
      { tsNs: "1754380800000000001", line: "первая", labels: { host: "sl-1" } },
      {
        tsNs: "1754380800000000002",
        line: "вторая\n",
        labels: { host: "sl-2" },
      },
    ]);
  } finally {
    await stop();
  }
});

describe("мусор в теле: пропуск поштучно, а не отказ", () => {
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
          result: [
            {
              values: [
                "не массив",
                ["одна"],
                [1, "нестроковый ts"],
                ["не-целое", "строка"],
                ["2", 42],
                ["3", "жива", "лишнее"],
              ],
            },
          ],
        },
      }),
      1,
    ],
  ];

  for (const [title, body, expected] of cases) {
    it(title, async () => {
      const { baseUrl, stop } = await serveFetch(
        () => new Response(body, { status: 200 }),
      );
      try {
        expect((await queryRange({ baseUrl }, QUERY)).length).toStrictEqual(
          expected,
        );
      } finally {
        await stop();
      }
    });
  }
});

it("метки потока: строковые берутся, прочие и не-объект — нет", async () => {
  const body = JSON.stringify({
    data: {
      result: [
        {
          stream: { host: "sl-1", n: 7, stream: "stderr" },
          values: [["1", "a"]],
        },
        { stream: "мусор", values: [["2", "b"]] },
        { values: [["3", "c"]] },
      ],
    },
  });
  const { baseUrl, stop } = await serveFetch(
    () => new Response(body, { status: 200 }),
  );
  try {
    const entries = await queryRange({ baseUrl }, QUERY);
    expect(entries.map((entry) => entry.labels)).toStrictEqual([
      { host: "sl-1", stream: "stderr" },
      {},
      {},
    ]);
  } finally {
    await stop();
  }
});

it("ответ вне 2xx — LokiHttpError с кодом и телом", async () => {
  const { baseUrl, stop } = await serveFetch(
    () =>
      new Response("  end timestamp must not be before start  ", {
        status: 400,
      }),
  );
  try {
    const err = await rejected(
      () => queryRange({ baseUrl }, QUERY),
      LokiHttpError,
    );
    expect(err.status).toBe(400);
    expect(err.body).toBe("  end timestamp must not be before start  ");
  } finally {
    await stop();
  }
});

it("сетевой сбой — LokiError, а не отказ с кодом", async () => {
  const { baseUrl, stop } = await serveFetch(
    () => new Response("", { status: 200 }),
  );
  await stop();
  const err = await rejected(() => queryRange({ baseUrl }, QUERY), LokiError);
  expect(err instanceof LokiHttpError).toBe(false);
});
