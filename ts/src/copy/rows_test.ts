/**
 * Перенос строк (`copy-client.md`, шаги 3–4): литералы, фильтры и
 * форма операторов.
 *
 * Это единственное место семейства, где команда собирает SQL из чужих
 * данных, — и единственное, что можно проверить целиком без стенда.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { SqlOutcome } from "../sql/render.ts";
import type { SqlSession } from "../sql/session.ts";
import {
  insertsOf,
  literalOf,
  spreadsheetIds,
  spreadsheetWhere,
  tableStatements,
} from "./rows.ts";

/** Сессия, отвечающая одним заданным набором строк. */
function reader(outcome: SqlOutcome, seen: string[] = []): SqlSession {
  return {
    query: (sql: string) => {
      seen.push(sql);
      return Promise.resolve(outcome);
    },
    run: (sql: string) => {
      seen.push(sql);
      return Promise.resolve({ kind: "done", rowcount: 0 } as SqlOutcome);
    },
    close: () => Promise.resolve(),
  };
}

Deno.test("литералы: типы, которые нельзя подставить как есть", async (t) => {
  await t.step("текст и кавычка внутри", () => {
    assertEquals(literalOf("обычный"), "'обычный'");
    assertEquals(literalOf("д'Артаньян"), "'д''Артаньян'");
  });

  await t.step("null, булево, числа", () => {
    assertEquals(literalOf(null), "NULL");
    assertEquals(literalOf(undefined), "NULL");
    assertEquals(literalOf(true), "true");
    assertEquals(literalOf(42), "42");
    assertEquals(literalOf(-1.5), "-1.5");
  });

  await t.step("нечисловые числа — строковые литералы PostgreSQL", () => {
    // Голым текстом `Infinity` сервер не примет: это синтаксическая
    // ошибка, а не значение.
    assertEquals(literalOf(Infinity), "'Infinity'");
    assertEquals(literalOf(-Infinity), "'-Infinity'");
    assertEquals(literalOf(NaN), "'NaN'");
  });

  await t.step("bytea — hex, а не JSON-обёртка буфера", () => {
    // JSON.stringify дал бы `{"type":"Buffer",…}`: в bytea это не
    // влезет, а в text-колонку влезет и молча испортит содержимое.
    assertEquals(literalOf(new Uint8Array([0, 15, 255])), "'\\x000fff'");
  });

  await t.step("массив — фигурные скобки, а не квадратные", () => {
    // `[1,2]` даёт `malformed array literal`.
    assertEquals(literalOf([1, 2]), '\'{"1","2"}\'');
    assertEquals(literalOf([null]), "'{NULL}'");
  });
});

Deno.test("spreadsheet_id — строка, а не число", async (t) => {
  await t.step("идентификаторы квотируются", () => {
    // У Google это `1BxiMVs0XRA5…`: приведение к числу выбросило бы их
    // все, и дети таблиц скопировались бы нулями — тихая недокопия.
    assertEquals(
      spreadsheetWhere(["1BxiMVs0XRA5", "abc"]),
      "spreadsheet_id IN ('1BxiMVs0XRA5', 'abc')",
    );
  });

  await t.step("пустое множество — предикат false, а не IN ()", () => {
    assertEquals(spreadsheetWhere([]), "false");
  });

  await t.step("читаются как строки", async () => {
    const outcome: SqlOutcome = {
      kind: "rows",
      columns: ["spreadsheet_id"],
      rows: [["1BxiMVs0XRA5"], ["другой-id"]],
    };
    assertEquals(await spreadsheetIds(reader(outcome), 5175), [
      "1BxiMVs0XRA5",
      "другой-id",
    ]);
  });
});

Deno.test("операторы таблицы: DELETE, затем вставка прочитанного", async (t) => {
  const outcome: SqlOutcome = {
    kind: "rows",
    columns: ["client_id", "name"],
    rows: [[5175, "первый"], [5175, null]],
  };

  await t.step("оба оператора и счётчик", async () => {
    const prepared = await tableStatements(
      reader(outcome),
      "wb_tokens",
      "client_id = 5175",
    );
    assertEquals(prepared.count, { table: "wb_tokens", rows: 2 });
    assertEquals(
      prepared.statements[0],
      "DELETE FROM public.wb_tokens WHERE client_id = 5175;",
    );
    assertStringIncludes(
      prepared.statements[1],
      "INSERT INTO public.wb_tokens",
    );
    assertStringIncludes(prepared.statements[1], "(5175, 'первый')");
    assertStringIncludes(prepared.statements[1], "(5175, NULL)");
  });

  await t.step("пустая таблица — только DELETE", async () => {
    const empty: SqlOutcome = { kind: "rows", columns: ["a"], rows: [] };
    const prepared = await tableStatements(reader(empty), "clients", "id = 1");
    assertEquals(prepared.statements.length, 1);
    assertEquals(prepared.count.rows, 0);
  });

  await t.step("фильтр удаления шире фильтра выборки", async () => {
    const seen: string[] = [];
    const prepared = await tableStatements(
      reader(outcome, seen),
      "spreadsheets_sheets",
      "spreadsheet_id IN ('новый')",
      "spreadsheet_id IN ('новый', 'старый')",
    );
    // Читаем по множеству источника, удаляем по объединению: таблица,
    // удалённая на источнике, иначе оставила бы висячих детей.
    assertStringIncludes(seen[0], "WHERE spreadsheet_id IN ('новый')");
    assertStringIncludes(
      prepared.statements[0],
      "DELETE FROM public.spreadsheets_sheets WHERE spreadsheet_id IN " +
        "('новый', 'старый');",
    );
  });
});

Deno.test("insertsOf: имена колонок квотируются", () => {
  const sql = insertsOf("t", ["client_id", "order"], [[1, "x"]]);
  // `order` — ключевое слово: без кавычек оператор не разобрался бы.
  assertStringIncludes(sql, '("client_id", "order")');
  assertEquals(insertsOf("t", ["a"], []), "");
});
