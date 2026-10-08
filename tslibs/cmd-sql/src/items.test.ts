/**
 * Строки SQL записями для отбора: колонка → значение и обратно; без
 * набора строк — пусто, результат не меняется.
 */

import { expect, it } from "vitest";
import { SQL_ITEMS } from "./items.ts";
import type { SqlResult } from "./run.ts";

const META = {
  server: "sl-1",
  host: "10.0.0.1",
  port: 5432,
  database: "mp",
  searchPath: null,
  sql: "select",
  dry: false,
};

it("набор строк — записи и обратно", () => {
  const result: SqlResult = {
    ...META,
    outcome: {
      kind: "rows",
      columns: ["n", "s"],
      rows: [
        [1, "a"],
        [2, null],
      ],
    },
  };
  const records = SQL_ITEMS.records(result);
  expect(records).toStrictEqual([
    { n: 1, s: "a" },
    { n: 2, s: null },
  ]);
  expect(SQL_ITEMS.with(result, records.slice(1))).toStrictEqual({
    ...META,
    outcome: { kind: "rows", columns: ["n", "s"], rows: [[2, null]] },
  });
});

it("без набора строк — пусто, результат прежний", () => {
  for (const result of [
    { ...META, outcome: { kind: "done" as const, rowcount: 3 } },
    { ...META, dry: true, outcome: null },
  ]) {
    expect(SQL_ITEMS.records(result)).toStrictEqual([]);
    expect(SQL_ITEMS.with(result, [])).toStrictEqual(result);
  }
});
