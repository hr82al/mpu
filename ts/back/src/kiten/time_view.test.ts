/**
 * Оформление записей времени (`docs/specs/kiten-time.md`, «CLI-контракт»).
 * Таблица и JSON проверены здесь на составе и порядке; побайтовая сверка
 * с голденами канала идёт в `cmd_time_test.ts`, где вывод собирает сама
 * команда.
 */

import { describe, expect, it } from "vitest";
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

describe("formatDuration: часы и минуты словами", () => {
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
    it(`${minutes} → ${text}`, () => {
      expect(formatDuration(minutes)).toStrictEqual(text);
    });
  }
});

describe("formatLogCount: склонение по числу", () => {
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
    it(text, () => {
      expect(formatLogCount(count)).toStrictEqual(text);
    });
  }
});

describe("roleLabel: колонка роли заполнена всегда", () => {
  it("название есть", () => {
    expect(roleLabel(view())).toBe("Техподдержка");
  });

  it("названия нет — числовой id", () => {
    expect(roleLabel(view({ role: null }))).toBe("12058");
  });

  it("нет ни названия, ни id — пусто", () => {
    expect(roleLabel(view({ role: null, role_id: null }))).toBe("");
  });
});

describe("renderTimeLogTable: состав колонок и итог", () => {
  it("без --all колонки пользователя нет", () => {
    const text = renderTimeLogTable([view()], 75, { withUser: false });
    expect(text.split("\n")[0].split(/\s{2,}/)).toStrictEqual([
      "ID",
      "ДАТА",
      "ВРЕМЯ",
      "РОЛЬ",
      "КОММЕНТАРИЙ",
    ]);
    expect(text.endsWith("итого: 1 ч 15 мин (1 запись)\n")).toBe(true);
  });

  it("с --all добавлена колонка пользователя", () => {
    const text = renderTimeLogTable([view()], 75, { withUser: true });
    expect(text.split("\n")[0].split(/\s{2,}/)).toStrictEqual([
      "ID",
      "ДАТА",
      "ВРЕМЯ",
      "РОЛЬ",
      "ПОЛЬЗОВАТЕЛЬ",
      "КОММЕНТАРИЙ",
    ]);
  });

  it("пустой комментарий оставляет колонку пустой", () => {
    const text = renderTimeLogTable([view({ comment: "" })], 75, {
      withUser: false,
    });
    const row = text.split("\n")[1];
    expect(row.includes("—")).toBe(false);
    expect(row.trimEnd().endsWith("Техподдержка")).toBe(true);
  });

  it("порядок строк — порядок списка", () => {
    const text = renderTimeLogTable(
      [view({ id: 7000002 }), view({ id: 7000001 })],
      150,
      { withUser: false },
    );
    const ids = text.split("\n").slice(1, 3).map((row) => row.split(" ")[0]);
    expect(ids).toStrictEqual(["7000002", "7000001"]);
  });

  it("нет записей — (пусто) без итога", () => {
    expect(renderTimeLogTable([], 0, { withUser: false })).toBe("(пусто)\n");
  });
});

it("renderTimeLogJson: отступ 2 и один перевод строки", () => {
  const text = renderTimeLogJson([view()], 75);
  expect(text.endsWith("}\n")).toBe(true);
  expect(text.endsWith("}\n\n")).toBe(false);
  expect(JSON.parse(text)).toStrictEqual({
    total_minutes: 75,
    logs: [view()],
  });
  expect(text.includes('\n  "logs"')).toBe(true);
});

describe("timeLogView: у поля роли два состояния — название и null", () => {
  it("название переносится как есть", () => {
    expect(timeLogView(catalogLog()).role).toBe("Техподдержка");
  });

  it("названия нет — null", () => {
    expect(timeLogView(catalogLog({ roleName: null })).role).toStrictEqual(
      null,
    );
  });

  it("пустое название — тот же null, а не пустая строка", () => {
    expect(timeLogView(catalogLog({ roleName: "" })).role).toStrictEqual(null);
  });
});
