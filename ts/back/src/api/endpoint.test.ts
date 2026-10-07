/**
 * Разбор ввода декларативной команды (`api.md`, «Декларативные
 * команды»): подстановка пути, сборка тела и типизация полей.
 */

import { expect, it } from "vitest";
import { thrown } from "../testing/thrown.ts";
import { UsageError } from "../command/mod.ts";
import {
  bodyFromFields,
  type FieldSpec,
  fillPath,
  pathParams,
  typedValue,
} from "./endpoint.ts";

it("path-параметры перечисляются в порядке пути", () => {
  expect(
    pathParams("/admin/client/:clientId/ss/:spreadsheetId/dataset/:sheetName"),
  ).toStrictEqual(["clientId", "spreadsheetId", "sheetName"]);
  expect(pathParams("/admin/client")).toStrictEqual([]);
});

it("значение экранируется целиком, включая слэш", () => {
  expect(fillPath("/admin/client/:clientId/ss/:ssId/dataset/:sheetName", {
    clientId: "777",
    ssId: "1BxiMVs0",
    // Оператор вправе назвать лист как угодно; слэш в имени не должен
    // уводить запрос на соседний эндпоинт.
    sheetName: "Отчёт/2026 ?x=1&y=2",
  })).toStrictEqual(
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

it("незаданные поля в тело не входят", () => {
  expect(bodyFromFields([RANGE, DIMENSION], { range: "A1:B2" })).toStrictEqual({
    range: "A1:B2",
  });
});

it("ни одного заданного поля — запрос без тела", () => {
  expect(bodyFromFields([DIMENSION], {})).toStrictEqual(undefined);
});

it("обязательное поле без значения — ошибка ввода", () => {
  const err = thrown(() => {
    bodyFromFields([RANGE], {});
  }, UsageError);
  expect(err.message).toBe("--range обязателен");
});

it("число разбирается в обеих формах записи", () => {
  const field: FieldSpec = { name: "n", type: "number", help: "" };
  expect(typedValue(field, "12")).toBe(12);
  expect(typedValue(field, "-3")).toBe(-3);
  expect(typedValue(field, "2.5")).toBe(2.5);
  expect(typedValue(field, "1e3")).toBe(1000);
});

it("дробная запись целого значения уходит целым — расхождение с оригиналом", () => {
  // В JS число одно, и `2.0` печатается как `2`; Python отправил бы
  // `2.0`. Ни у одного читающего эндпоинта числовых полей нет, поэтому
  // расхождение сейчас недостижимо — но оно есть, и лучше пусть о нём
  // говорит тест, чем оно всплывёт на первом же числовом поле пишущей
  // половины.
  const field: FieldSpec = { name: "n", type: "number", help: "" };
  expect(JSON.stringify(typedValue(field, "2.0"))).toBe("2");
});

it("число: префикс из цифр числом не считается", () => {
  const field: FieldSpec = { name: "n", type: "number", help: "" };
  for (const value of ["12abc", "", "нет", "1.2.3", "0x10"]) {
    const err = thrown(() => {
      typedValue(field, value);
    }, UsageError);
    expect(err.message).toStrictEqual(
      `--n: ожидается число, получено '${value}'`,
    );
  }
});

it("boolean: восемь слов истины и лжи без учёта регистра", () => {
  const field: FieldSpec = { name: "flag", type: "boolean", help: "" };
  for (const value of ["true", "YES", "1", "On"]) {
    expect(typedValue(field, value)).toBe(true);
  }
  for (const value of ["false", "No", "0", "OFF"]) {
    expect(typedValue(field, value)).toBe(false);
  }
  const err = thrown(() => {
    typedValue(field, "ага");
  }, UsageError);
  expect(err.message).toBe(
    "--flag: ожидается boolean (true/false/yes/no/1/0), получено 'ага'",
  );
});

it("json: литерал разбирается, негодный называет начало значения", () => {
  const field: FieldSpec = { name: "filter", type: "json", help: "" };
  expect(typedValue(field, '{"a":[1,2]}')).toStrictEqual({ a: [1, 2] });
  const err = thrown(() => {
    typedValue(field, "{нет");
  }, UsageError);
  expect(
    err.message.startsWith("--filter: ожидается JSON, получено '{нет...': "),
    err.message,
  ).toBe(true);
});
