/**
 * План чтения (`docs/specs/sheet-batch.md`, «batch-get»): слияние
 * инструкций, опции «последнее слово побеждает» и границы аспектов.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { UsageError } from "../command/mod.ts";
import { planRead } from "./readplan.ts";

Deno.test("инструкции сливаются в один план, опции — последнее слово", () => {
  const plan = planRead(
    "get A1:B2 formula\nget C1 unformatted cols\nread merges\nread props merges",
    "Sheet1",
  );
  assertEquals(plan.ranges, ["Sheet1!A1:B2", "Sheet1!C1"]);
  assertEquals(plan.valueRenderOption, "UNFORMATTED_VALUE");
  assertEquals(plan.majorDimension, "COLUMNS");
  // Аспекты дедуплицируются, порядок — первого появления.
  assertEquals(plan.aspects, ["merges", "props"]);
});

Deno.test("диапазон без листа префиксуется -n, имя кавычится по правилу A1", () => {
  assertEquals(planRead("get A1", "Мой лист").ranges, ["'Мой лист'!A1"]);
  assertEquals(planRead("get 'Другой'!A1", "Sheet1").ranges, ["'Другой'!A1"]);
  // Без -n диапазон уходит как есть: листы на компиляции не проверяются.
  assertEquals(planRead("get A1").ranges, ["A1"]);
});

Deno.test("токен, не бывший аспектом, — имя листа-фильтра", () => {
  const plan = planRead("read Sheet1 merges Второй", "Sheet1");
  assertEquals(plan.aspects, ["merges"]);
  assertEquals(plan.sheets, ["Sheet1", "Второй"]);
});

Deno.test("per-cell аспект отбивается с перечнем доступных", () => {
  const err = assertThrows(() => planRead("read note"), UsageError);
  assertEquals(
    err.message,
    "аспект 'note' (per-cell) недоступен: webApp не отдаёт gridData. " +
      "Доступны: banding, charts, cond, dims, filters, merges, meta, " +
      "named, props, protected",
  );
});

Deno.test("глагол не get и не read — своя ошибка", () => {
  const err = assertThrows(() => planRead("trim A1"), UsageError);
  assertEquals(
    err.message,
    "read-глагол должен быть get|read, получено 'trim'",
  );
});

Deno.test("ни диапазонов, ни аспектов — пустой скрипт чтения", () => {
  assertThrows(() => planRead("get"), UsageError, "пустой скрипт чтения");
});

Deno.test("умолчания плана — те, что названы спекой", () => {
  const plan = planRead("get A1");
  assertEquals(plan.valueRenderOption, "FORMATTED_VALUE");
  assertEquals(plan.majorDimension, "ROWS");
  assertEquals(plan.dateTimeRenderOption, "SERIAL_NUMBER");
  assertEquals(
    planRead("get A1 datestr").dateTimeRenderOption,
    "FORMATTED_STRING",
  );
});
