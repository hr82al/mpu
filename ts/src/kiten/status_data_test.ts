/**
 * Правила сбора строк `mpu kiten status` (`docs/specs/kiten-status.md`)
 * — над готовыми данными, без сети: слияние версий, попадание в окно,
 * сортировка и фильтры.
 */

import { assertEquals } from "@std/assert";
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

Deno.test("слияние: побеждает версия с известной колонкой", async (t) => {
  await t.step("усечённая версия не затирает полную", () => {
    const rows = rowsOf([
      input({ source: "time", column: null, board: null, lane: null }),
      input({ source: "assigned" }),
    ]);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].column, "В работе");
    assertEquals(rows[0].stage, "В работе");
    // Источники объединяются в множество и идут по алфавиту.
    assertEquals(rows[0].sources, ["assigned", "time"]);
  });

  await t.step("порядок версий на исход не влияет", () => {
    const full = input({ source: "assigned" });
    const short = input({ source: "activity", column: null });
    assertEquals(rowsOf([full, short])[0].column, "В работе");
    assertEquals(rowsOf([short, full])[0].column, "В работе");
  });

  await t.step("минуты берутся по id карточки", () => {
    assertEquals(rowsOf([input()], { 1: 125 })[0].myMinutes, 125);
    assertEquals(rowsOf([input()])[0].myMinutes, 0);
  });

  await t.step("эскалация и завершённость — из той же версии", () => {
    const escalated = rowsOf([input({ column: "Эскалация" })])[0];
    assertEquals(escalated.escalated, true);
    assertEquals(escalated.stage, "В работе");
    assertEquals(rowsOf([input({ state: "done" })])[0].closed, true);
    assertEquals(rowsOf([input({ condition: 2 })])[0].closed, true);
    assertEquals(rowsOf([input({ archived: true })])[0].closed, true);
  });
});

Deno.test("окно --since: живые всегда, архивные только внутри", async (t) => {
  const now = Math.floor(Date.parse("2026-08-19T12:00:00Z") / 1000);
  const since = now - 7 * DAY;

  await t.step("живая карточка видна и вне окна", () => {
    const row = rowsOf([input({ updated: "2020-01-01T00:00:00Z" })])[0];
    assertEquals(inWindow(row, since), true);
  });

  await t.step("архивная внутри окна видна, вне — нет", () => {
    const fresh = rowsOf([
      input({ condition: 2, updated: "2026-08-18T09:00:00Z" }),
    ])[0];
    const old = rowsOf([
      input({ condition: 2, updated: "2026-07-01T09:00:00Z" }),
    ])[0];
    assertEquals(inWindow(fresh, since), true);
    assertEquals(inWindow(old, since), false);
  });

  await t.step("завершённая по этапу, но живая — видна вне окна", () => {
    // `state=done` при `condition=1` — это не архив: карточка живая, и
    // окно к ней не применяется (спека, п. 6).
    const row = rowsOf([
      input({ state: "done", updated: "2020-01-01T00:00:00Z" }),
    ])[0];
    assertEquals(row.closed, true);
    assertEquals(inWindow(row, since), true);
  });

  await t.step("неизвестное время у архивной — не видна", () => {
    const row = rowsOf([input({ condition: 2, updated: null })])[0];
    assertEquals(inWindow(row, since), false);
  });
});

Deno.test("сортировка: незавершённые выше, внутри — свежие раньше", () => {
  const rows = rowsOf([
    input({ id: 1, state: "done", updated: "2026-08-19T10:00:00Z" }),
    input({ id: 2, updated: "2026-08-17T10:00:00Z" }),
    input({ id: 3, updated: "2026-08-18T10:00:00Z" }),
  ]);
  assertEquals(sortRows(rows).map((row) => row.id), [3, 2, 1]);
});

Deno.test("фильтры сужают выдачу независимо друг от друга", async (t) => {
  const rows = rowsOf([
    input({ id: 1, column: "Тестирование", source: "assigned" }),
    input({ id: 2, column: "В работе", source: "activity" }),
    input({ id: 3, column: "В работе", source: "time", state: "done" }),
    input({ id: 2, column: "В работе", source: "time" }),
  ]);

  await t.step("по этапу", () => {
    assertEquals(
      applyFilters(rows, { stage: "Тест" }).map((row) => row.id),
      [1],
    );
  });

  await t.step("по источнику — вхождение, не единственность", () => {
    assertEquals(
      applyFilters(rows, { source: "time" }).map((row) => row.id),
      [2, 3],
    );
  });

  await t.step("touch — только из ленты и больше ниоткуда", () => {
    // У карточки 2 источников два (лента и время), поэтому она не
    // touch: `touch` значит «не назначена и время не списывал».
    assertEquals(applyFilters(rows, { source: "touch" }), []);
    const onlyFeed = rowsOf([input({ id: 9, source: "activity" })]);
    assertEquals(
      applyFilters(onlyFeed, { source: "touch" }).map((row) => row.id),
      [9],
    );
  });

  await t.step("по завершённости", () => {
    assertEquals(
      applyFilters(rows, { only: "done" }).map((row) => row.id),
      [3],
    );
    assertEquals(
      applyFilters(rows, { only: "open" }).map((row) => row.id),
      [1, 2],
    );
  });

  await t.step("по доске", () => {
    const mixed = rowsOf([
      input({ id: 1, board: "Доска 1" }),
      input({ id: 2, board: "Доска 2" }),
    ]);
    assertEquals(
      applyFilters(mixed, { board: "Доска 2" }).map((row) => row.id),
      [2],
    );
  });
});
