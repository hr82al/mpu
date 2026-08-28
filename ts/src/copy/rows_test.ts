/**
 * Перенос строк (`copy-client.md`, шаги 3–4): значения-параметры,
 * фильтры и форма операторов.
 *
 * Это единственное место семейства, где команда переносит чужие данные
 * в чужие колонки, — и единственное, что можно проверить целиком без
 * стенда.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { SqlOutcome } from "../sql/render.ts";
import type { SqlSession } from "../sql/session.ts";
import { clientOptions } from "../sql/pg.ts";
import {
  clientWhere,
  insertsOf,
  paramOf,
  spreadsheetIds,
  spreadsheetWhere,
  tableStatements,
} from "./rows.ts";

/** OID типов, о которых идёт речь; числа фиксированы каталогом. */
const JSON_OID = 114;
const JSONB_OID = 3802;
const TEXT_ARRAY_OID = 1009;
const TEXT_OID = 25;

/** Сессия, отвечающая одним заданным набором строк. */
function reader(
  outcome: SqlOutcome,
  seen: string[] = [],
  sentParams: (readonly unknown[] | undefined)[] = [],
): SqlSession {
  return {
    query: (sql: string, params?: readonly unknown[]) => {
      seen.push(sql);
      sentParams.push(params);
      return Promise.resolve(outcome);
    },
    run: (sql: string) => {
      seen.push(sql);
      return Promise.resolve({ kind: "done", rowcount: 0 } as SqlOutcome);
    },
    runMany: () => Promise.reject(new Error("runMany не ожидается")),
    close: () => Promise.resolve(),
  };
}

Deno.test("форма входа: чем именно драйвер отдаёт json и массивы", async (t) => {
  // Проверка того самого утверждения, на которое опирался прежний
  // докстринг: он говорил «json приходит текстом», и это было неверно.
  // Спрашиваем не наш код, а разборщики, которые мы же и настраиваем
  // (`clientOptions`), — то есть форму, как её отдаёт драйвер.
  const parsers = clientOptions(
    { host: "h", port: 1, database: "d", username: "u", password: "p" },
    "write",
  ).types;

  await t.step("json и jsonb приходят разобранными значениями JS", () => {
    assertEquals(parsers?.getTypeParser(JSON_OID, "text")("[1,2]"), [1, 2]);
    assertEquals(parsers?.getTypeParser(JSONB_OID, "text")('{"a":1}'), {
      a: 1,
    });
  });

  await t.step("text[] приходит массивом — тем же, чем и json-массив", () => {
    // В этом вся суть: по значению их не различить, различает только
    // тип колонки.
    assertEquals(parsers?.getTypeParser(TEXT_ARRAY_OID, "text")("{a,b}"), [
      "a",
      "b",
    ]);
  });

  await t.step("дата приходит текстом — она в списке текстовых", () => {
    assertEquals(
      parsers?.getTypeParser(1082, "text")("2026-08-28"),
      "2026-08-28",
    );
  });
});

Deno.test("значение параметра: json сериализуется, остальное — как есть", async (t) => {
  await t.step("массив в json уходит текстом JSON", () => {
    // Литерал массива PostgreSQL (`{"a","b"}`) в json не годится —
    // именно на нём падал перенос: invalid input syntax for type json.
    assertEquals(paramOf(["a", "b"], JSON_OID), '["a","b"]');
    assertEquals(paramOf(["a", "b"], JSONB_OID), '["a","b"]');
    assertEquals(paramOf({ a: 1 }, JSONB_OID), '{"a":1}');
  });

  await t.step("массив в text[] уходит массивом — сериализует драйвер", () => {
    assertEquals(paramOf(["a", "b"], TEXT_ARRAY_OID), ["a", "b"]);
  });

  await t.step("готовый текст json второй раз не заворачивается", () => {
    assertEquals(paramOf('{"a":1}', JSONB_OID), '{"a":1}');
  });

  await t.step("null остаётся null при любом типе", () => {
    assertEquals(paramOf(null, JSONB_OID), null);
    assertEquals(paramOf(undefined, TEXT_OID), null);
  });

  await t.step("прочие значения не трогаются вовсе", () => {
    // bytea приходит сюда уже текстовой формой PostgreSQL: в значение
    // ячейки его переводит `toValue` (`sql/pg.ts`), а не эта функция.
    assertEquals(paramOf("\\x000fff", 17), "\\x000fff");
    assertEquals(paramOf(42, 23), 42);
    assertEquals(paramOf("д'Артаньян", TEXT_OID), "д'Артаньян");
  });
});

Deno.test("вставка: значения уходят параметрами, а не текстом", async (t) => {
  await t.step("места $n по порядку, значения отдельно", () => {
    const [statement] = insertsOf(
      "wb_tokens",
      ["client_id", "name"],
      [[5175, "первый"], [5175, null]],
      [23, TEXT_OID],
    );
    assertEquals(
      statement.sql,
      'INSERT INTO public.wb_tokens ("client_id", "name") VALUES\n' +
        "  ($1, $2),\n  ($3, $4)",
    );
    assertEquals(statement.params, [5175, "первый", 5175, null]);
    assertEquals(statement.label, "wb_tokens");
  });

  await t.step("кавычка в значении не влияет на текст запроса", () => {
    // Ровно то, ради чего параметры: содержимое данных больше не может
    // изменить оператор.
    const [statement] = insertsOf("t", ["name"], [["О'Брайен"]], [TEXT_OID]);
    assertEquals(statement.sql.includes("О'Брайен"), false);
    assertEquals(statement.params, ["О'Брайен"]);
  });

  await t.step("json-колонка сериализуется, соседняя text[] — нет", () => {
    const [statement] = insertsOf(
      "spreadsheets_sheets_values",
      ["values", "tags"],
      [[[",,,Настройки", "for_graph"], ["a", "b"]]],
      [JSONB_OID, TEXT_ARRAY_OID],
    );
    assertEquals(statement.params, [
      '[",,,Настройки","for_graph"]',
      ["a", "b"],
    ]);
  });

  await t.step("пустая выборка не даёт оператора вовсе", () => {
    assertEquals(insertsOf("t", ["a"], [], [TEXT_OID]).length, 0);
  });

  await t.step("длинная таблица режется по пределу параметров", () => {
    // 65535 параметров на запрос — предел протокола; при трёх колонках
    // это 21845 строк, и 21846-я обязана уехать вторым оператором.
    const rows = Array.from({ length: 21_846 }, () => [1, 2, 3]);
    const statements = insertsOf("t", ["a", "b", "c"], rows, [23, 23, 23]);
    assertEquals(statements.length, 2);
    assertEquals(statements[0].params?.length, 65_535);
    assertEquals(statements[1].params?.length, 3);
  });
});

Deno.test("фильтры: значения тоже параметры", async (t) => {
  await t.step("клиент — по номеру", () => {
    assertEquals(clientWhere(5175), {
      text: "client_id = $1",
      params: [5175],
    });
  });

  await t.step("идентификаторы таблиц — строки, каждая своим местом", () => {
    // У Google это `1BxiMVs0XRA5…`: приведение к числу выбросило бы их
    // все, и дети таблиц скопировались бы нулями — тихая недокопия.
    assertEquals(spreadsheetWhere(["1BxiMVs0XRA5", "abc"]), {
      text: "spreadsheet_id IN ($1, $2)",
      params: ["1BxiMVs0XRA5", "abc"],
    });
  });

  await t.step("пустое множество — предикат false, а не IN ()", () => {
    assertEquals(spreadsheetWhere([]), { text: "false", params: [] });
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
    oids: [23, TEXT_OID],
    rows: [[5175, "первый"], [5175, null]],
  };

  await t.step("оба оператора, счётчик и метка таблицы", async () => {
    const prepared = await tableStatements(
      reader(outcome),
      "wb_tokens",
      clientWhere(5175),
    );
    assertEquals(prepared.count, { table: "wb_tokens", rows: 2 });
    assertEquals(prepared.statements[0], {
      sql: "DELETE FROM public.wb_tokens WHERE client_id = $1",
      params: [5175],
      label: "wb_tokens",
    });
    assertStringIncludes(
      prepared.statements[1].sql,
      "INSERT INTO public.wb_tokens",
    );
    assertEquals(prepared.statements[1].params, [5175, "первый", 5175, null]);
  });

  await t.step("пустая таблица — только DELETE", async () => {
    const empty: SqlOutcome = { kind: "rows", columns: ["a"], rows: [] };
    const prepared = await tableStatements(
      reader(empty),
      "clients",
      { text: "id = $1", params: [1] },
    );
    assertEquals(prepared.statements.length, 1);
    assertEquals(prepared.count.rows, 0);
  });

  await t.step("фильтр удаления шире фильтра выборки", async () => {
    const seen: string[] = [];
    const asked: (readonly unknown[] | undefined)[] = [];
    const prepared = await tableStatements(
      reader(outcome, seen, asked),
      "spreadsheets_sheets",
      spreadsheetWhere(["новый"]),
      spreadsheetWhere(["новый", "старый"]),
    );
    // Читаем по множеству источника, удаляем по объединению: таблица,
    // удалённая на источнике, иначе оставила бы висячих детей.
    assertStringIncludes(seen[0], "WHERE spreadsheet_id IN ($1)");
    // Значения выборки уходят параметрами вместе с текстом: без них
    // запрос ушёл бы с пустым `$1` и вернул не то.
    assertEquals(asked[0], ["новый"]);
    assertEquals(prepared.statements[0].params, ["новый", "старый"]);
  });
});
