/**
 * Строки SQL записями для отбора: колонка → значение и обратно; без
 * набора строк — пусто, результат не меняется.
 */

import { assertEquals } from "@std/assert";
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

Deno.test("набор строк — записи и обратно", () => {
  const result: SqlResult = {
    ...META,
    outcome: { kind: "rows", columns: ["n", "s"], rows: [[1, "a"], [2, null]] },
  };
  const records = SQL_ITEMS.records(result);
  assertEquals(records, [{ n: 1, s: "a" }, { n: 2, s: null }]);
  assertEquals(SQL_ITEMS.with(result, records.slice(1)), {
    ...META,
    outcome: { kind: "rows", columns: ["n", "s"], rows: [[2, null]] },
  });
});

Deno.test("без набора строк — пусто, результат прежний", () => {
  for (
    const result of [
      { ...META, outcome: { kind: "done" as const, rowcount: 3 } },
      { ...META, dry: true, outcome: null },
    ]
  ) {
    assertEquals(SQL_ITEMS.records(result), []);
    assertEquals(SQL_ITEMS.with(result, []), result);
  }
});
