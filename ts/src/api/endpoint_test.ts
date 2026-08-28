/**
 * Разбор ввода декларативной команды (`api.md`, «Декларативные
 * команды»): подстановка пути, сборка тела и типизация полей.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { UsageError } from "../command/mod.ts";
import {
  bodyFromFields,
  type FieldSpec,
  fillPath,
  pathParams,
  typedValue,
} from "./endpoint.ts";

Deno.test("path-параметры перечисляются в порядке пути", () => {
  assertEquals(
    pathParams("/admin/client/:clientId/ss/:spreadsheetId/dataset/:sheetName"),
    ["clientId", "spreadsheetId", "sheetName"],
  );
  assertEquals(pathParams("/admin/client"), []);
});

Deno.test("значение экранируется целиком, включая слэш", () => {
  assertEquals(
    fillPath("/admin/client/:clientId/ss/:ssId/dataset/:sheetName", {
      clientId: "777",
      ssId: "1BxiMVs0",
      // Оператор вправе назвать лист как угодно; слэш в имени не должен
      // уводить запрос на соседний эндпоинт.
      sheetName: "Отчёт/2026 ?x=1&y=2",
    }),
    "/admin/client/777/ss/1BxiMVs0/dataset/" +
      "%D0%9E%D1%82%D1%87%D1%91%D1%82%2F2026%20%3Fx%3D1%26y%3D2",
  );
});

const RANGE: FieldSpec = {
  name: "range",
  type: "string",
  required: true,
  help: "A1 range",
};
const DIMENSION: FieldSpec = {
  name: "majorDimension",
  type: "string",
  help: "ROWS|COLUMNS",
};

Deno.test("незаданные поля в тело не входят", () => {
  assertEquals(bodyFromFields([RANGE, DIMENSION], { range: "A1:B2" }), {
    range: "A1:B2",
  });
});

Deno.test("ни одного заданного поля — запрос без тела", () => {
  assertEquals(bodyFromFields([DIMENSION], {}), undefined);
});

Deno.test("обязательное поле без значения — ошибка ввода", () => {
  const err = assertThrows(
    () => bodyFromFields([RANGE], {}),
    UsageError,
  );
  assertEquals(err.message, "--range обязателен");
});

Deno.test("число разбирается в обеих формах записи", () => {
  const field: FieldSpec = { name: "n", type: "number", help: "" };
  assertEquals(typedValue(field, "12"), 12);
  assertEquals(typedValue(field, "-3"), -3);
  assertEquals(typedValue(field, "2.5"), 2.5);
  assertEquals(typedValue(field, "1e3"), 1000);
});

Deno.test("дробная запись целого значения уходит целым — расхождение с оригиналом", () => {
  // В JS число одно, и `2.0` печатается как `2`; Python отправил бы
  // `2.0`. Ни у одного читающего эндпоинта числовых полей нет, поэтому
  // расхождение сейчас недостижимо — но оно есть, и лучше пусть о нём
  // говорит тест, чем оно всплывёт на первом же числовом поле пишущей
  // половины.
  const field: FieldSpec = { name: "n", type: "number", help: "" };
  assertEquals(JSON.stringify(typedValue(field, "2.0")), "2");
});

Deno.test("число: префикс из цифр числом не считается", () => {
  const field: FieldSpec = { name: "n", type: "number", help: "" };
  for (const value of ["12abc", "", "нет", "1.2.3", "0x10"]) {
    const err = assertThrows(() => typedValue(field, value), UsageError);
    assertEquals(err.message, `--n: ожидается число, получено '${value}'`);
  }
});

Deno.test("boolean: восемь слов истины и лжи без учёта регистра", () => {
  const field: FieldSpec = { name: "flag", type: "boolean", help: "" };
  for (const value of ["true", "YES", "1", "On"]) {
    assertEquals(typedValue(field, value), true);
  }
  for (const value of ["false", "No", "0", "OFF"]) {
    assertEquals(typedValue(field, value), false);
  }
  const err = assertThrows(() => typedValue(field, "ага"), UsageError);
  assertEquals(
    err.message,
    "--flag: ожидается boolean (true/false/yes/no/1/0), получено 'ага'",
  );
});

Deno.test("json: литерал разбирается, негодный называет начало значения", () => {
  const field: FieldSpec = { name: "filter", type: "json", help: "" };
  assertEquals(typedValue(field, '{"a":[1,2]}'), { a: [1, 2] });
  const err = assertThrows(() => typedValue(field, "{нет"), UsageError);
  assertEquals(
    err.message.startsWith("--filter: ожидается JSON, получено '{нет...': "),
    true,
    err.message,
  );
});
