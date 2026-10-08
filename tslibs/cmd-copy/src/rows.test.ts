/**
 * Перенос строк (`copy-client.md`, шаги 3–4): значения-параметры,
 * фильтры и форма операторов.
 *
 * Это единственное место семейства, где команда переносит чужие данные
 * в чужие колонки, — и единственное, что можно проверить целиком без
 * стенда.
 */

import { describe, expect, it } from "vitest";
import type { SqlOutcome, SqlSession } from "@mpu/cmd-sql";
import { clientOptions } from "@mpu/cmd-sql/pg";
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

describe("форма входа: чем именно драйвер отдаёт json и массивы", () => {
  // Проверка того самого утверждения, на которое опирался прежний
  // докстринг: он говорил «json приходит текстом», и это было неверно.
  // Спрашиваем не наш код, а разборщики, которые мы же и настраиваем
  // (`clientOptions`), — то есть форму, как её отдаёт драйвер.
  const parsers = clientOptions(
    { host: "h", port: 1, database: "d", username: "u", password: "p" },
    "write",
  ).types;

  it("json и jsonb приходят разобранными значениями JS", () => {
    expect(parsers?.getTypeParser(JSON_OID, "text")("[1,2]")).toStrictEqual([
      1, 2,
    ]);
    expect(parsers?.getTypeParser(JSONB_OID, "text")('{"a":1}')).toStrictEqual({
      a: 1,
    });
  });

  it("text[] приходит массивом — тем же, чем и json-массив", () => {
    // В этом вся суть: по значению их не различить, различает только
    // тип колонки.
    expect(
      parsers?.getTypeParser(TEXT_ARRAY_OID, "text")("{a,b}"),
    ).toStrictEqual(["a", "b"]);
  });

  it("дата приходит текстом — она в списке текстовых", () => {
    expect(parsers?.getTypeParser(1082, "text")("2026-08-28")).toBe(
      "2026-08-28",
    );
  });
});

describe("значение параметра: json сериализуется, остальное — как есть", () => {
  it("массив в json уходит текстом JSON", () => {
    // Литерал массива PostgreSQL (`{"a","b"}`) в json не годится —
    // именно на нём падал перенос: invalid input syntax for type json.
    expect(paramOf(["a", "b"], JSON_OID)).toBe('["a","b"]');
    expect(paramOf(["a", "b"], JSONB_OID)).toBe('["a","b"]');
    expect(paramOf({ a: 1 }, JSONB_OID)).toBe('{"a":1}');
  });

  it("массив в text[] уходит массивом — сериализует драйвер", () => {
    expect(paramOf(["a", "b"], TEXT_ARRAY_OID)).toStrictEqual(["a", "b"]);
  });

  it("скаляр в json тоже сериализуется", () => {
    // Колонка со значением `"привет"` приходит от драйвера **строкой**
    // `привет`: он разобрал JSON. Отдать её как есть — отправить
    // серверу текст, который не JSON: ровно на этом падала вторая
    // таблица, когда первая уже проходила.
    expect(paramOf("привет", JSONB_OID)).toBe('"привет"');
    expect(paramOf(42, JSONB_OID)).toBe("42");
    expect(paramOf(true, JSONB_OID)).toBe("true");
  });

  it("строка с текстом JSON внутри не меняет тип молча", () => {
    // Значение — строка, внутри которой лежит текст объекта. Отдай её
    // как есть, сервер разобрал бы её объектом: отказа нет, а тип
    // значения в колонке сменился.
    expect(paramOf('{"вложенный":1}', JSONB_OID)).toBe('"{\\"вложенный\\":1}"');
  });

  it("null остаётся null при любом типе", () => {
    expect(paramOf(null, JSONB_OID)).toStrictEqual(null);
    expect(paramOf(undefined, TEXT_OID)).toStrictEqual(null);
  });

  it("прочие значения не трогаются вовсе", () => {
    // bytea приходит сюда уже текстовой формой PostgreSQL: в значение
    // ячейки его переводит `toValue` (`@mpu/cmd-sql`, `src/pg.ts`), а не эта функция.
    expect(paramOf("\\x000fff", 17)).toBe("\\x000fff");
    expect(paramOf(42, 23)).toBe(42);
    expect(paramOf("д'Артаньян", TEXT_OID)).toBe("д'Артаньян");
  });
});

it("круг json: что пришло из колонки, то и уходит обратно", () => {
  // Сильнее ручных ожиданий: значение прогоняется через настоящий
  // разборщик драйвера и обратно через `paramOf`. Совпадение побайтно
  // означает, что тип значения в колонке не сменился ни на одной форме
  // — включая строку, внутри которой лежит текст JSON.
  const parse = clientOptions(
    { host: "h", port: 1, database: "d", username: "u", password: "p" },
    "write",
  ).types?.getTypeParser(JSONB_OID, "text");
  for (const raw of [
    '"привет"',
    "123",
    "true",
    '{"a":1}',
    '["a","b"]',
    '"{\\"вложенный\\":1}"',
    '[",,,Настройки отчета",null,3]',
  ]) {
    expect(paramOf(parse?.(raw), JSONB_OID), raw).toStrictEqual(raw);
  }
});

describe("вставка: значения уходят параметрами, а не текстом", () => {
  it("места $n по порядку, значения отдельно", () => {
    const [statement] = insertsOf(
      "wb_tokens",
      ["client_id", "name"],
      [
        [5175, "первый"],
        [5175, null],
      ],
      [23, TEXT_OID],
    );
    expect(statement.sql).toStrictEqual(
      'INSERT INTO public.wb_tokens ("client_id", "name") VALUES\n' +
        "  ($1, $2),\n  ($3, $4)",
    );
    expect(statement.params).toStrictEqual([5175, "первый", 5175, null]);
    expect(statement.label).toBe("wb_tokens");
  });

  it("кавычка в значении не влияет на текст запроса", () => {
    // Ровно то, ради чего параметры: содержимое данных больше не может
    // изменить оператор.
    const [statement] = insertsOf("t", ["name"], [["О'Брайен"]], [TEXT_OID]);
    expect(statement.sql.includes("О'Брайен")).toBe(false);
    expect(statement.params).toStrictEqual(["О'Брайен"]);
  });

  it("json-колонка сериализуется, соседняя text[] — нет", () => {
    const [statement] = insertsOf(
      "spreadsheets_sheets_values",
      ["values", "tags"],
      [
        [
          [",,,Настройки", "for_graph"],
          ["a", "b"],
        ],
      ],
      [JSONB_OID, TEXT_ARRAY_OID],
    );
    expect(statement.params).toStrictEqual([
      '[",,,Настройки","for_graph"]',
      ["a", "b"],
    ]);
  });

  it("пустая выборка не даёт оператора вовсе", () => {
    expect(insertsOf("t", ["a"], [], [TEXT_OID]).length).toBe(0);
  });

  it("длинная таблица режется по пределу параметров", () => {
    // 65535 параметров на запрос — предел протокола; при трёх колонках
    // это 21845 строк, и 21846-я обязана уехать вторым оператором.
    const rows = Array.from({ length: 21_846 }, () => [1, 2, 3]);
    const statements = insertsOf("t", ["a", "b", "c"], rows, [23, 23, 23]);
    expect(statements.length).toBe(2);
    expect(statements[0].params?.length).toBe(65_535);
    expect(statements[1].params?.length).toBe(3);
  });
});

describe("фильтры: значения тоже параметры", () => {
  it("клиент — по номеру", () => {
    expect(clientWhere(5175)).toStrictEqual({
      text: "client_id = $1",
      params: [5175],
    });
  });

  it("идентификаторы таблиц — строки, каждая своим местом", () => {
    // У Google это `1BxiMVs0XRA5…`: приведение к числу выбросило бы их
    // все, и дети таблиц скопировались бы нулями — тихая недокопия.
    expect(spreadsheetWhere(["1BxiMVs0XRA5", "abc"])).toStrictEqual({
      text: "spreadsheet_id IN ($1, $2)",
      params: ["1BxiMVs0XRA5", "abc"],
    });
  });

  it("пустое множество — предикат false, а не IN ()", () => {
    expect(spreadsheetWhere([])).toStrictEqual({ text: "false", params: [] });
  });

  it("читаются как строки", async () => {
    const outcome: SqlOutcome = {
      kind: "rows",
      columns: ["spreadsheet_id"],
      rows: [["1BxiMVs0XRA5"], ["другой-id"]],
    };
    expect(await spreadsheetIds(reader(outcome), 5175)).toStrictEqual([
      "1BxiMVs0XRA5",
      "другой-id",
    ]);
  });
});

describe("операторы таблицы: DELETE, затем вставка прочитанного", () => {
  const outcome: SqlOutcome = {
    kind: "rows",
    columns: ["client_id", "name"],
    oids: [23, TEXT_OID],
    rows: [
      [5175, "первый"],
      [5175, null],
    ],
  };

  it("оба оператора, счётчик и метка таблицы", async () => {
    const prepared = await tableStatements(
      reader(outcome),
      "wb_tokens",
      clientWhere(5175),
    );
    expect(prepared.count).toStrictEqual({ table: "wb_tokens", rows: 2 });
    expect(prepared.statements[0]).toStrictEqual({
      sql: "DELETE FROM public.wb_tokens WHERE client_id = $1",
      params: [5175],
      label: "wb_tokens",
    });
    expect(prepared.statements[1].sql).toContain(
      "INSERT INTO public.wb_tokens",
    );
    expect(prepared.statements[1].params).toStrictEqual([
      5175,
      "первый",
      5175,
      null,
    ]);
  });

  it("пустая таблица — только DELETE", async () => {
    const empty: SqlOutcome = { kind: "rows", columns: ["a"], rows: [] };
    const prepared = await tableStatements(reader(empty), "clients", {
      text: "id = $1",
      params: [1],
    });
    expect(prepared.statements.length).toBe(1);
    expect(prepared.count.rows).toBe(0);
  });

  it("фильтр удаления шире фильтра выборки", async () => {
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
    expect(seen[0]).toContain("WHERE spreadsheet_id IN ($1)");
    // Значения выборки уходят параметрами вместе с текстом: без них
    // запрос ушёл бы с пустым `$1` и вернул не то.
    expect(asked[0]).toStrictEqual(["новый"]);
    expect(prepared.statements[0].params).toStrictEqual(["новый", "старый"]);
  });
});
