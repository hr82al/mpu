/**
 * Оформление записей времени (`docs/specs/kiten-time.md`, «CLI-контракт»).
 * Таблица и JSON проверены здесь на составе и порядке; побайтовая сверка
 * с голденами канала идёт в `cmd_time_test.ts`, где вывод собирает сама
 * команда.
 */

import { assertEquals } from "@std/assert";
import type { TimeLog } from "../kaiten/mod.ts";
import {
  formatDuration,
  formatLogCount,
  renderTimeLogJson,
  renderTimeLogTable,
  roleLabel,
  type TimeLogView,
  timeLogView,
} from "./time_view.ts";

/** Запись каталога: форма, из которой строится вывод. */
function catalogLog(patch: Partial<TimeLog> = {}): TimeLog {
  return {
    id: 7000001,
    cardId: 10000001,
    userId: 900001,
    authorId: 900001,
    roleId: 12058,
    roleName: "Техподдержка",
    userName: "Иван Тестов",
    timeSpent: 75,
    forDate: "2026-08-14",
    comment: "разбор жалобы",
    ...patch,
  };
}

function view(patch: Partial<TimeLogView> = {}): TimeLogView {
  return {
    id: 7000001,
    card_id: 10000001,
    for_date: "2026-08-14",
    minutes: 75,
    role_id: 12058,
    role: "Техподдержка",
    user_id: 900001,
    user: "Иван Тестов",
    comment: "разбор жалобы",
    ...patch,
  };
}

Deno.test("formatDuration: часы и минуты словами", async (t) => {
  const cases: readonly [number, string][] = [
    [75, "1 ч 15 мин"],
    [120, "2 ч"],
    [45, "45 мин"],
    [1, "1 мин"],
    [1440, "24 ч"],
    // Ноль приходит от сервера у записи без длительности: печатается, а
    // не превращается в пустую ячейку.
    [0, "0 мин"],
  ];
  for (const [minutes, text] of cases) {
    await t.step(`${minutes} → ${text}`, () => {
      assertEquals(formatDuration(minutes), text);
    });
  }
});

Deno.test("formatLogCount: склонение по числу", async (t) => {
  const cases: readonly [number, string][] = [
    [0, "0 записей"],
    [1, "1 запись"],
    [2, "2 записи"],
    [4, "4 записи"],
    [5, "5 записей"],
    [11, "11 записей"],
    [14, "14 записей"],
    [21, "21 запись"],
    [22, "22 записи"],
    [111, "111 записей"],
  ];
  for (const [count, text] of cases) {
    await t.step(text, () => {
      assertEquals(formatLogCount(count), text);
    });
  }
});

Deno.test("roleLabel: колонка роли заполнена всегда", async (t) => {
  await t.step("название есть", () => {
    assertEquals(roleLabel(view()), "Техподдержка");
  });

  await t.step("названия нет — числовой id", () => {
    assertEquals(roleLabel(view({ role: null })), "12058");
  });

  await t.step("нет ни названия, ни id — пусто", () => {
    assertEquals(roleLabel(view({ role: null, role_id: null })), "");
  });
});

Deno.test("renderTimeLogTable: состав колонок и итог", async (t) => {
  await t.step("без --all колонки пользователя нет", () => {
    const text = renderTimeLogTable([view()], 75, { withUser: false });
    assertEquals(text.split("\n")[0].split(/\s{2,}/), [
      "ID",
      "ДАТА",
      "ВРЕМЯ",
      "РОЛЬ",
      "КОММЕНТАРИЙ",
    ]);
    assertEquals(text.endsWith("итого: 1 ч 15 мин (1 запись)\n"), true);
  });

  await t.step("с --all добавлена колонка пользователя", () => {
    const text = renderTimeLogTable([view()], 75, { withUser: true });
    assertEquals(text.split("\n")[0].split(/\s{2,}/), [
      "ID",
      "ДАТА",
      "ВРЕМЯ",
      "РОЛЬ",
      "ПОЛЬЗОВАТЕЛЬ",
      "КОММЕНТАРИЙ",
    ]);
  });

  await t.step("пустой комментарий оставляет колонку пустой", () => {
    const text = renderTimeLogTable([view({ comment: "" })], 75, {
      withUser: false,
    });
    const row = text.split("\n")[1];
    assertEquals(row.includes("—"), false);
    assertEquals(row.trimEnd().endsWith("Техподдержка"), true);
  });

  await t.step("порядок строк — порядок списка", () => {
    const text = renderTimeLogTable(
      [view({ id: 7000002 }), view({ id: 7000001 })],
      150,
      { withUser: false },
    );
    const ids = text.split("\n").slice(1, 3).map((row) => row.split(" ")[0]);
    assertEquals(ids, ["7000002", "7000001"]);
  });

  await t.step("нет записей — (пусто) без итога", () => {
    assertEquals(renderTimeLogTable([], 0, { withUser: false }), "(пусто)\n");
  });
});

Deno.test("renderTimeLogJson: отступ 2 и один перевод строки", () => {
  const text = renderTimeLogJson([view()], 75);
  assertEquals(text.endsWith("}\n"), true);
  assertEquals(text.endsWith("}\n\n"), false);
  assertEquals(JSON.parse(text), {
    total_minutes: 75,
    logs: [view()],
  });
  assertEquals(text.includes('\n  "logs"'), true);
});

Deno.test("timeLogView: у поля роли два состояния — название и null", async (t) => {
  await t.step("название переносится как есть", () => {
    assertEquals(timeLogView(catalogLog()).role, "Техподдержка");
  });

  await t.step("названия нет — null", () => {
    assertEquals(timeLogView(catalogLog({ roleName: null })).role, null);
  });

  await t.step("пустое название — тот же null, а не пустая строка", () => {
    assertEquals(timeLogView(catalogLog({ roleName: "" })).role, null);
  });
});
