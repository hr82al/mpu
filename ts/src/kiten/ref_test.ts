import { assertEquals, assertThrows } from "@std/assert";
import { UsageError } from "../command/mod.ts";
import type { Column, Lane } from "../kaiten/mod.ts";
import { resolveRef } from "./ref.ts";

const BOARD_ID = 4000001;

function column(id: number, title: string, sortOrder: number | null): Column {
  return { id, boardId: BOARD_ID, title, sortOrder };
}

/** Порядок массива не совпадает ни с id, ни с положением слева направо. */
const COLUMNS: readonly Column[] = [
  column(5000001, "Готово", 3),
  column(5000002, "Бэклог", 1),
  column(5000003, "В работе", 2),
];

const LANES: readonly Lane[] = [
  { id: 6000001, boardId: BOARD_ID, title: "Веб" },
  { id: 6000002, boardId: BOARD_ID, title: "Мобилки" },
];

Deno.test("resolveColumn: id, точное имя, подстрока", async (t) => {
  await t.step("числовая ссылка — колонка с этим id", () => {
    assertEquals(resolveRef("column", COLUMNS, "5000003").title, "В работе");
  });

  await t.step("точное имя старше подстроки", () => {
    const columns = [...COLUMNS, column(5000004, "Готово к релизу", 4)];
    assertEquals(resolveRef("column", columns, "готово").id, 5000001);
  });

  await t.step("подстрока без учёта регистра", () => {
    assertEquals(resolveRef("column", COLUMNS, "РАБОТ").id, 5000003);
  });

  await t.step("ни одного совпадения — ошибка ввода", () => {
    assertThrows(
      () => resolveRef("column", COLUMNS, "Архив"),
      UsageError,
      "column 'Архив' не найден — см. `mpu kiten columns`",
    );
  });

  await t.step("числовая ссылка мимо доски — тот же отказ", () => {
    assertThrows(
      () => resolveRef("column", COLUMNS, "999"),
      UsageError,
      "column '999' не найден",
    );
  });

  await t.step("несколько совпадений — кандидаты в подробностях", () => {
    const err = assertThrows(
      () => resolveRef("column", COLUMNS, "о"),
      UsageError,
    ) as UsageError;
    assertEquals(err.message, "column 'о' неоднозначен (3 совпадений):");
    assertEquals(
      err.details,
      "5000001 (Готово)\n5000002 (Бэклог)\n5000003 (В работе)",
    );
  });
});

Deno.test("вид справочника стоит в отказе", async (t) => {
  await t.step("дорожка не найдена", () => {
    assertThrows(
      () => resolveRef("lane", LANES, "Десктоп"),
      UsageError,
      "lane 'Десктоп' не найден — см. `mpu kiten lanes`",
    );
  });
  await t.step("доска неоднозначна", () => {
    const err = assertThrows(
      () =>
        resolveRef("board", [
          { id: 1, title: "Поддержка" },
          { id: 2, title: "Поддержка клиентов" },
        ], "поддержк"),
      UsageError,
    ) as UsageError;
    assertEquals(err.message, "board 'поддержк' неоднозначен (2 совпадений):");
    assertEquals(err.details, "1 (Поддержка)\n2 (Поддержка клиентов)");
  });
  await t.step("резолв возвращает саму запись, не только id", () => {
    assertEquals(resolveRef("lane", LANES, "6000002").title, "Мобилки");
  });
});
