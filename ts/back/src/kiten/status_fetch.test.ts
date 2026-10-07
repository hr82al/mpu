/**
 * Сбор трёх источников `mpu kiten status` (`docs/specs/kiten-status.md`,
 * шаги 2–8). Сети нет: вызовы Kaiten подставные, проверяются правила —
 * какое окно к чему применяется, что перепроверяется и что остаётся.
 */

import { describe, expect, it } from "vitest";
import type { CardSummary } from "@mpu/kaiten";
import {
  columnTitlesFor,
  feedPageCap,
  harvest,
  type StatusApi,
} from "./status_fetch.ts";

const DAY = 86_400;
const NOW = Math.floor(Date.parse("2026-08-19T12:00:00Z") / 1000);
const SINCE = NOW - 7 * DAY;
const TIME_SINCE = NOW - 365 * DAY;

const url = (id: number) => `https://kaiten.example/space/1/card/${id}`;

function card(overrides: Partial<CardSummary> = {}): CardSummary {
  return {
    id: 1,
    title: "Карточка",
    state: 2,
    condition: 1,
    dueDate: null,
    updated: "2026-08-19T09:00:00Z",
    boardId: 10,
    columnId: 100,
    laneId: 20,
    archived: false,
    lastMovedAt: null,
    timeSpentSum: null,
    boardTitle: "Доска 1",
    spaceTitles: ["Пространство 1"],
    columnTitle: "В работе",
    laneTitle: "Дорожка 1",
    typeName: null,
    ...overrides,
  };
}

/** Подставные вызовы: по умолчанию каждый источник пуст. */
function api(overrides: Partial<StatusApi> = {}): StatusApi {
  return {
    cardsOfMember: () => Promise.resolve([]),
    cardsOfResponsible: () => Promise.resolve([]),
    timeLogs: () => Promise.resolve([]),
    activities: () => Promise.resolve([]),
    commentsOf: () => Promise.resolve([]),
    columnsOf: () => Promise.resolve([]),
    ...overrides,
  };
}

const windows = { since: SINCE, timeSince: TIME_SINCE, now: NOW };

it("потолок страниц ленты — недели окна × 3, не больше 12", () => {
  expect(feedPageCap(NOW - 7 * DAY, NOW)).toBe(3);
  expect(feedPageCap(NOW - 14 * DAY, NOW)).toBe(6);
  // Окно короче недели всё равно даёт хотя бы одну неделю.
  expect(feedPageCap(NOW - 3600, NOW)).toBe(3);
  expect(feedPageCap(NOW - 365 * DAY, NOW)).toBe(12);
});

it("время: сумма за --time-since, источник — за --since", async () => {
  const old = {
    id: 1,
    cardId: 5,
    userId: 1,
    authorId: 1,
    roleId: null,
    roleName: null,
    userName: null,
    timeSpent: 30,
    forDate: "2026-01-10",
    comment: "",
    card: null,
  };
  const fresh = { ...old, id: 2, timeSpent: 45, forDate: "2026-08-18" };
  const harvested = await harvest(
    api({ timeLogs: () => Promise.resolve([old, fresh]) }),
    windows,
    1,
    url,
  );
  // Обе записи в сумме, хотя старая вне окна `--since`.
  expect(harvested.minutes[5]).toBe(75);
  // Версии карточки нет: у записей `card` пуст — источник помечать не на чем.
  expect(harvested.inputs).toStrictEqual([]);
});

it("лента: события вне окна не создают строк", async () => {
  const inside = {
    id: "a1",
    created: "2026-08-18T10:00:00Z",
    action: "card_move",
    cardId: 7,
    card: card({ id: 7 }),
  };
  const outside = {
    id: "a2",
    created: "2026-07-01T10:00:00Z",
    action: "card_move",
    cardId: 8,
    card: card({ id: 8 }),
  };
  const harvested = await harvest(
    api({ activities: () => Promise.resolve([inside, outside]) }),
    windows,
    1,
    url,
  );
  expect(harvested.inputs.map((input) => input.id)).toStrictEqual([7]);
  // Самое старое прочитанное событие старше начала окна — лента полна.
  expect(harvested.feedComplete).toBe(true);
});

it("неполная лента видна по самому старому событию", async () => {
  const recent = {
    id: "a1",
    created: "2026-08-18T10:00:00Z",
    action: "card_add",
    cardId: 7,
    card: card({ id: 7 }),
  };
  const harvested = await harvest(
    api({ activities: () => Promise.resolve([recent]) }),
    windows,
    1,
    url,
  );
  // Лента кончилась новее начала окна: часть карточек могла не попасть.
  expect(harvested.feedComplete).toBe(false);
  expect(harvested.oldestFeedAt).toBe("2026-08-18T10:00:00Z");
});

describe("перепроверка карточки, попавшей одним комментарием", () => {
  const commentEvent = {
    id: "a1",
    created: "2026-08-18T10:00:00Z",
    action: "comment_add",
    cardId: 9,
    card: card({ id: 9 }),
  };

  it("моего комментария нет — строка отбрасывается", async () => {
    const harvested = await harvest(
      api({
        activities: () => Promise.resolve([commentEvent]),
        commentsOf: () => Promise.resolve([{ authorId: 42 }]),
      }),
      windows,
      1,
      url,
    );
    expect(harvested.inputs).toStrictEqual([]);
  });

  it("мой комментарий на месте — строка остаётся", async () => {
    const harvested = await harvest(
      api({
        activities: () => Promise.resolve([commentEvent]),
        commentsOf: () => Promise.resolve([{ authorId: 1 }]),
      }),
      windows,
      1,
      url,
    );
    expect(harvested.inputs.map((input) => input.id)).toStrictEqual([9]);
  });

  it("проверка не удалась — строка остаётся", async () => {
    const harvested = await harvest(
      api({
        activities: () => Promise.resolve([commentEvent]),
        commentsOf: () => Promise.reject(new Error("нет доступа")),
      }),
      windows,
      1,
      url,
    );
    expect(harvested.inputs.map((input) => input.id)).toStrictEqual([9]);
  });

  it("второе событие сверх комментария — без проверки", async () => {
    let asked = 0;
    const harvested = await harvest(
      api({
        activities: () =>
          Promise.resolve([
            commentEvent,
            { ...commentEvent, id: "a2", action: "card_move" },
          ]),
        commentsOf: () => {
          asked++;
          return Promise.resolve([]);
        },
      }),
      windows,
      1,
      url,
    );
    expect(asked).toBe(0);
    expect(harvested.inputs.length).toBe(2);
  });
});

describe("названия колонок: кэш, дозагрузка и недоступная доска", () => {
  const rows = [{ id: 100, board_id: 10, title: "В работе" }];
  const db = {
    query: () => rows,
  } as unknown as Parameters<typeof columnTitlesFor>[0];

  it("доска из кэша не дозагружается", async () => {
    let asked = 0;
    const titles = await columnTitlesFor(
      db,
      {
        columnsOf: () => {
          asked++;
          return Promise.resolve([]);
        },
      },
      [10],
      () => {},
    );
    expect(asked).toBe(0);
    expect(titles[100]).toBe("В работе");
  });

  it("доски нет в кэше — колонки дозагружаются и пишутся", async () => {
    const written: number[] = [];
    const titles = await columnTitlesFor(
      db,
      {
        columnsOf: (boardId) =>
          Promise.resolve([
            { id: 200, boardId, title: "Тестирование", sortOrder: null },
          ]),
      },
      [11],
      (boardId) => written.push(boardId),
    );
    expect(titles[200]).toBe("Тестирование");
    expect(written).toStrictEqual([11]);
  });

  it("недоступная доска не роняет сбор", async () => {
    const titles = await columnTitlesFor(
      db,
      {
        columnsOf: () => Promise.reject(new Error("403")),
      },
      [12],
      () => {},
    );
    // Названий её колонок нет — этап строк станет `—`, но не отказом.
    expect(titles[100]).toBe("В работе");
  });
});
