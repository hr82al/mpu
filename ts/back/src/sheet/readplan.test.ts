/**
 * План чтения (`docs/specs/sheet-batch.md`, «batch-get»): слияние
 * инструкций, опции «последнее слово побеждает» и границы аспектов.
 */

import { expect, it } from "vitest";
import { thrown } from "../testing/thrown.ts";
import { UsageError } from "../command/mod.ts";
import { planRead } from "./readplan.ts";

it("инструкции сливаются в один план, опции — последнее слово", () => {
  const plan = planRead(
    "get A1:B2 formula\nget C1 unformatted cols\nread merges\nread props merges",
    "Sheet1",
  );
  expect(plan.ranges).toStrictEqual(["Sheet1!A1:B2", "Sheet1!C1"]);
  expect(plan.valueRenderOption).toBe("UNFORMATTED_VALUE");
  expect(plan.majorDimension).toBe("COLUMNS");
  // Аспекты дедуплицируются, порядок — первого появления.
  expect(plan.aspects).toStrictEqual(["merges", "props"]);
});

it("диапазон без листа префиксуется -n, имя кавычится по правилу A1", () => {
  expect(planRead("get A1", "Мой лист").ranges).toStrictEqual([
    "'Мой лист'!A1",
  ]);
  expect(planRead("get 'Другой'!A1", "Sheet1").ranges).toStrictEqual([
    "'Другой'!A1",
  ]);
  // Без -n диапазон уходит как есть: листы на компиляции не проверяются.
  expect(planRead("get A1").ranges).toStrictEqual(["A1"]);
});

it("токен, не бывший аспектом, — имя листа-фильтра", () => {
  const plan = planRead("read Sheet1 merges Второй", "Sheet1");
  expect(plan.aspects).toStrictEqual(["merges"]);
  expect(plan.sheets).toStrictEqual(["Sheet1", "Второй"]);
});

it("per-cell аспект отбивается с перечнем доступных", () => {
  const err = thrown(() => {
    planRead("read note");
  }, UsageError);
  expect(err.message).toStrictEqual(
    "аспект 'note' (per-cell) недоступен: webApp не отдаёт gridData. " +
      "Доступны: banding, charts, cond, dims, filters, merges, meta, " +
      "named, props, protected",
  );
});

it("глагол не get и не read — своя ошибка", () => {
  const err = thrown(() => {
    planRead("trim A1");
  }, UsageError);
  expect(err.message).toBe("read-глагол должен быть get|read, получено 'trim'");
});

it("ни диапазонов, ни аспектов — пустой скрипт чтения", () => {
  expect(() => planRead("get")).toThrow(UsageError);
  expect(() => planRead("get")).toThrow("пустой скрипт чтения");
});

it("умолчания плана — те, что названы спекой", () => {
  const plan = planRead("get A1");
  expect(plan.valueRenderOption).toBe("FORMATTED_VALUE");
  expect(plan.majorDimension).toBe("ROWS");
  expect(plan.dateTimeRenderOption).toBe("SERIAL_NUMBER");
  expect(planRead("get A1 datestr").dateTimeRenderOption).toBe(
    "FORMATTED_STRING",
  );
});
