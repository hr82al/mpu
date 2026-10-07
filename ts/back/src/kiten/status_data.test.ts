/**
 * Правила сбора строк `mpu kiten status` (`docs/specs/kiten-status.md`)
 * — над готовыми данными, без сети: слияние версий, попадание в окно,
 * сортировка и фильтры.
 */

import { describe, expect, it } from "vitest";
import {
  applyFilters,
  inWindow,
  mergeInputs,
  sortRows,
  type StatusInput,
  type StatusRow,
} from "./status_data.ts";

const DAY = 86_400;

/** Версия карточки от источника; всё, кроме названного, — умолчания. */
function input(overrides: Partial<StatusInput> = {}): StatusInput {
  return {
    id: 1,
    title: "Карточка",
    url: "https://kaiten.example/1",
    column: "В работе",
    board: "Доска 1",
    space: "Пространство 1",
    lane: "Дорожка 1",
    state: "in_progress",
    condition: 1,
    archived: false,
    dueDate: null,
    updated: "2026-08-19T10:00:00Z",
    source: "assigned",
    ...overrides,
  };
}

function rowsOf(
  inputs: readonly StatusInput[],
  minutes: Record<number, number> = {},
): readonly StatusRow[] {
  return mergeInputs(inputs, minutes);
}

describe("слияние: побеждает версия с известной колонкой", () => {
  it("усечённая версия не затирает полную", () => {
    const rows = rowsOf([
      input({ source: "time", column: null, board: null, lane: null }),
      input({ source: "assigned" }),
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0].column).toBe("В работе");
    expect(rows[0].stage).toBe("В работе");
    // Источники объединяются в множество и идут по алфавиту.
    expect(rows[0].sources).toStrictEqual(["assigned", "time"]);
  });

  it("порядок версий на исход не влияет", () => {
    const full = input({ source: "assigned" });
    const short = input({ source: "activity", column: null });
    expect(rowsOf([full, short])[0].column).toBe("В работе");
    expect(rowsOf([short, full])[0].column).toBe("В работе");
  });

  it("минуты берутся по id карточки", () => {
    expect(rowsOf([input()], { 1: 125 })[0].myMinutes).toBe(125);
    expect(rowsOf([input()])[0].myMinutes).toBe(0);
  });

  it("эскалация и завершённость — из той же версии", () => {
    const escalated = rowsOf([input({ column: "Эскалация" })])[0];
    expect(escalated.escalated).toBe(true);
    expect(escalated.stage).toBe("В работе");
    expect(rowsOf([input({ state: "done" })])[0].closed).toBe(true);
    expect(rowsOf([input({ condition: 2 })])[0].closed).toBe(true);
    expect(rowsOf([input({ archived: true })])[0].closed).toBe(true);
  });
});

describe("окно --since: живые всегда, архивные только внутри", () => {
  const now = Math.floor(Date.parse("2026-08-19T12:00:00Z") / 1000);
  const since = now - 7 * DAY;

  it("живая карточка видна и вне окна", () => {
    const row = rowsOf([input({ updated: "2020-01-01T00:00:00Z" })])[0];
    expect(inWindow(row, since)).toBe(true);
  });

  it("архивная внутри окна видна, вне — нет", () => {
    const fresh = rowsOf([
      input({ condition: 2, updated: "2026-08-18T09:00:00Z" }),
    ])[0];
    const old = rowsOf([
      input({ condition: 2, updated: "2026-07-01T09:00:00Z" }),
    ])[0];
    expect(inWindow(fresh, since)).toBe(true);
    expect(inWindow(old, since)).toBe(false);
  });

  it("завершённая по этапу, но живая — видна вне окна", () => {
    // `state=done` при `condition=1` — это не архив: карточка живая, и
    // окно к ней не применяется (спека, п. 6).
    const row = rowsOf([
      input({ state: "done", updated: "2020-01-01T00:00:00Z" }),
    ])[0];
    expect(row.closed).toBe(true);
    expect(inWindow(row, since)).toBe(true);
  });

  it("неизвестное время у архивной — не видна", () => {
    const row = rowsOf([input({ condition: 2, updated: null })])[0];
    expect(inWindow(row, since)).toBe(false);
  });
});

it("сортировка: незавершённые выше, внутри — свежие раньше", () => {
  const rows = rowsOf([
    input({ id: 1, state: "done", updated: "2026-08-19T10:00:00Z" }),
    input({ id: 2, updated: "2026-08-17T10:00:00Z" }),
    input({ id: 3, updated: "2026-08-18T10:00:00Z" }),
  ]);
  expect(sortRows(rows).map((row) => row.id)).toStrictEqual([3, 2, 1]);
});

describe("фильтры сужают выдачу независимо друг от друга", () => {
  const rows = rowsOf([
    input({ id: 1, column: "Тестирование", source: "assigned" }),
    input({ id: 2, column: "В работе", source: "activity" }),
    input({ id: 3, column: "В работе", source: "time", state: "done" }),
    input({ id: 2, column: "В работе", source: "time" }),
  ]);

  it("по этапу", () => {
    expect(applyFilters(rows, { stage: "Тест" }).map((row) => row.id))
      .toStrictEqual([1]);
  });

  it("по источнику — вхождение, не единственность", () => {
    expect(applyFilters(rows, { source: "time" }).map((row) => row.id))
      .toStrictEqual([2, 3]);
  });

  it("touch — только из ленты и больше ниоткуда", () => {
    // У карточки 2 источников два (лента и время), поэтому она не
    // touch: `touch` значит «не назначена и время не списывал».
    expect(applyFilters(rows, { source: "touch" })).toStrictEqual([]);
    const onlyFeed = rowsOf([input({ id: 9, source: "activity" })]);
    expect(applyFilters(onlyFeed, { source: "touch" }).map((row) => row.id))
      .toStrictEqual([9]);
  });

  it("по завершённости", () => {
    expect(applyFilters(rows, { only: "done" }).map((row) => row.id))
      .toStrictEqual([3]);
    expect(applyFilters(rows, { only: "open" }).map((row) => row.id))
      .toStrictEqual([1, 2]);
  });

  it("по доске", () => {
    const mixed = rowsOf([
      input({ id: 1, board: "Доска 1" }),
      input({ id: 2, board: "Доска 2" }),
    ]);
    expect(applyFilters(mixed, { board: "Доска 2" }).map((row) => row.id))
      .toStrictEqual([2]);
  });
});
