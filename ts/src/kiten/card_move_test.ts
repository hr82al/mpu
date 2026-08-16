/**
 * Механика переноса карточки (`docs/specs/kiten-move.md`): резолв
 * колонки, порядок колонок доски, выбор соседа для релога и строка
 * положения. Всё это — чистые преобразования, поэтому проверяются
 * таблицей случаев, а не стендом; сетевую часть закрывает
 * `cmd_close_test.ts`, где та же механика идёт целиком.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { UsageError } from "../command/mod.ts";
import type { Column } from "../kaiten/mod.ts";
import {
  orderedColumns,
  positionLabel,
  relogNeighbour,
  resolveColumn,
} from "./card_move.ts";

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

Deno.test("resolveColumn: id, точное имя, подстрока", async (t) => {
  await t.step("числовая ссылка — колонка с этим id", () => {
    assertEquals(resolveColumn(COLUMNS, "5000003").title, "В работе");
  });

  await t.step("точное имя старше подстроки", () => {
    const columns = [...COLUMNS, column(5000004, "Готово к релизу", 4)];
    assertEquals(resolveColumn(columns, "готово").id, 5000001);
  });

  await t.step("подстрока без учёта регистра", () => {
    assertEquals(resolveColumn(COLUMNS, "РАБОТ").id, 5000003);
  });

  await t.step("ни одного совпадения — ошибка ввода", () => {
    assertThrows(
      () => resolveColumn(COLUMNS, "Архив"),
      UsageError,
      "column 'Архив' не найден — см. `mpu kiten columns`",
    );
  });

  await t.step("числовая ссылка мимо доски — тот же отказ", () => {
    assertThrows(
      () => resolveColumn(COLUMNS, "999"),
      UsageError,
      "column '999' не найден",
    );
  });

  await t.step("несколько совпадений — кандидаты в подробностях", () => {
    const err = assertThrows(
      () => resolveColumn(COLUMNS, "о"),
      UsageError,
    ) as UsageError;
    assertEquals(err.message, "column 'о' неоднозначен (3 совпадений):");
    assertEquals(
      err.details,
      "5000001 (Готово)\n5000002 (Бэклог)\n5000003 (В работе)",
    );
  });
});

Deno.test("orderedColumns: слева направо по весу, без веса — в конец", () => {
  const columns = [...COLUMNS, column(5000004, "Без веса", null)];
  assertEquals(
    orderedColumns(columns).map((item) => item.title),
    ["Бэклог", "В работе", "Готово", "Без веса"],
  );
});

Deno.test("orderedColumns: равные веса — по возрастанию id", () => {
  const columns = [column(20, "Б", 1), column(10, "А", 1)];
  assertEquals(orderedColumns(columns).map((item) => item.id), [10, 20]);
});

Deno.test("relogNeighbour: сосед слева, у крайней левой — справа", async (t) => {
  await t.step("обычная колонка — предыдущая по весу", () => {
    assertEquals(relogNeighbour(COLUMNS, 5000001).title, "В работе");
  });

  await t.step("крайняя левая — следующая справа", () => {
    assertEquals(relogNeighbour(COLUMNS, 5000002).title, "В работе");
  });

  await t.step("одна колонка на доске — релог невозможен", () => {
    assertThrows(
      () => relogNeighbour([COLUMNS[0]], 5000001),
      UsageError,
      "на доске одна колонка — релог невозможен",
    );
  });

  await t.step("цели нет среди колонок доски", () => {
    assertThrows(
      () => relogNeighbour(COLUMNS, 999),
      UsageError,
      "целевая колонка не найдена на доске карточки",
    );
  });
});

Deno.test("positionLabel: непустые части через разделитель", async (t) => {
  await t.step("все три части", () => {
    assertEquals(
      positionLabel({
        boardTitle: "Проекты",
        columnTitle: "Бэклог",
        laneTitle: "Разработка",
      }),
      "Проекты · Бэклог · Разработка",
    );
  });

  await t.step("пустые части выпадают", () => {
    assertEquals(
      positionLabel({
        boardTitle: "Проекты",
        columnTitle: "",
        laneTitle: null,
      }),
      "Проекты",
    );
  });

  await t.step("все пусты — прочерк", () => {
    assertEquals(
      positionLabel({ boardTitle: null, columnTitle: null, laneTitle: null }),
      "—",
    );
  });
});
