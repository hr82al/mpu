/**
 * Виды данных (`platform/collection-protocol.md`): что понимает
 * коллекция, запись, скаляр и `nil`, как они выглядят текстом и JSON.
 * Цепочка идёт от данных как от начала строки.
 */

import { describe, expect, it } from "vitest";
import { GRAMMAR } from "../messages/mod.ts";
import { runChain } from "./chain.ts";
import { collectionOf, resultData, SELECTABLE } from "./data.ts";
import { AsideCall } from "./method.ts";
import type { Outcome } from "./protocol.ts";
import { said } from "./testtree.ts";

const END = GRAMMAR.close;

/** Строка `words` над данными `value`: итог цепочки. */
function over(value: unknown, words: readonly string[]): Promise<Outcome> {
  const origin = new AsideCall(
    "mpu",
    { purpose: "данные", help: "Данные." },
    SELECTABLE.kind,
    () => resultData(value),
  );
  return runChain(words, origin);
}

const ROWS = [
  { id: 1, name: "a", tags: ["x"], size: 5, note: null },
  { id: 2, name: "B", tags: [], size: 10, note: "n" },
];

describe("виды данных: сообщения, текст и JSON", () => {
  const cases: readonly (readonly [unknown, readonly string[], Outcome])[] = [
    [
      ROWS,
      ["first"],
      {
        path: [],
        value: 'id\t1\nname\ta\ntags\t["x"]\nsize\t5\nnote\t\n',
      },
    ],
    [ROWS, ["first", "pick:", "size"], { path: [], value: "5\n" }],
    [ROWS, ["first", "tags"], { path: [], value: "x\n" }],
    [
      ROWS,
      ["first", "tags", END, "json"],
      {
        path: [],
        value: '[\n  "x"\n]\n',
      },
    ],
    [ROWS, ["pick:", "tags"], { path: [], value: '["x"]\n[]\n' }],
    [
      ROWS,
      ["sortBy:", "note", END, "first", "id"],
      {
        path: [],
        value: "2\n",
      },
    ],
    [
      ROWS,
      ["sortBy:", "size", END, "last", "id"],
      {
        path: [],
        value: "2\n",
      },
    ],
    [
      ROWS,
      ["where:", "size", "less:", "9", END, "size"],
      {
        path: [],
        value: "1\n",
      },
    ],
    [
      ROWS,
      ["where:", "tags", "is:", "x", END, "size"],
      {
        path: [],
        value: "0\n",
      },
    ],
    [ROWS, ["first", "note", END, "json"], { path: [], value: "null\n" }],
    [[], ["first", END, "json"], { path: [], value: "null\n" }],
    [{ stamp: "20260923" }, ["json"], { path: [], value: '"20260923"\n' }],
    [{ only: { a: 1 } }, ["only", "a"], { path: [], value: "1\n" }],
    [7, ["json"], { path: [], value: "7\n" }],
    [ROWS, ["last:", "1", END, "first", "id"], { path: [], value: "2\n" }],
    [ROWS, ["last:", "0", END, "size"], { path: [], value: "0\n" }],
    [
      ROWS,
      ["last:", "5", END, "pick:", "id"],
      {
        path: [],
        value: "1\n2\n",
      },
    ],
  ];
  for (const [value, words, outcome] of cases) {
    it(words.join(" "), async () => {
      expect(await over(value, words)).toStrictEqual(outcome);
    });
  }
});

describe("виды данных: отказы", () => {
  const cases: readonly (readonly [unknown, readonly string[], string])[] = [
    [ROWS, ["nope"], "mpu: коллекция не понимает nope"],
    [ROWS, ["sise"], "mpu: коллекция не понимает sise; ближайшие: size"],
    [ROWS, ["first", "id", "id"], "mpu first id: скаляр не понимает id"],
    [[], ["first", "id"], "mpu first: скаляр не понимает id"],
    [
      ROWS,
      ["pick:", "id", END, "pick:", "x"],
      "mpu pick: id end: скаляр не понимает x",
    ],
    [
      ROWS,
      ["first", "tags", "first", "x"],
      "mpu first tags first: скаляр не понимает x",
    ],
    [ROWS, ["json", "size"], "mpu json: не понимает size; формат — последним"],
    [ROWS, ["last:", "-1"], "mpu: last: -1 — ожидается n ≥ 0"],
    [
      ROWS,
      ["first", "nam"],
      "mpu first: запись не понимает nam; ближайшие: name",
    ],
  ];
  for (const [value, words, error] of cases) {
    it(words.join(" "), async () => {
      expect(said(await over(value, words))).toStrictEqual({ error, code: 2 });
    });
  }
});

it("данные отвечают протоколом отражения", async () => {
  const outcome = await over(ROWS, ["first", "messages", END, "json"]);
  const lines = JSON.parse(String((outcome as { value: string }).value));
  expect(
    lines.map((line: { selector: string }) => line.selector),
  ).toStrictEqual(["id", "name", "note", "pick:", "size", "tags"]);
  expect(await over(ROWS, ["understands:", "size"])).toStrictEqual({
    path: ["understands:"],
    value: "true\n",
  });
});

it("коллекция с видом источника: его текст над отобранным", async () => {
  const origin = new AsideCall(
    "mpu",
    { purpose: "данные", help: "Данные." },
    SELECTABLE.kind,
    () =>
      collectionOf(ROWS, {
        text: (items) => `${items.length} строк\n`,
      }),
  );
  expect(await runChain(["first:", "1"], origin)).toStrictEqual({
    path: [],
    value: "1 строк\n",
  });
  expect(await runChain(["pick:", "id"], origin)).toStrictEqual({
    path: [],
    value: "1\n2\n",
  });
});
