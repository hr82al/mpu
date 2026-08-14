/**
 * Каталог справочников и пользователя
 * (`docs/specs/platform/kaiten-api-refs.md`): по паре «запрос → ответ» на
 * каждый из шести вызовов, курсорный обход ленты действий, ошибки не-2xx и
 * границы раздела «Golden-примеры». Вызывающего кода у каталога в этой
 * волне нет (команд `mpu kiten` в порции нет), поэтому форму отправленного
 * запроса и разбор ответа держат именно эти тесты.
 *
 * Пространства, дорожки и колонки сверяются на golden-копиях канала
 * (`testdata/`, их совпадение с каналом стережёт `fixtures_test.ts`);
 * остальные фикстуры синтетические и объявлены здесь же — golden-файлов на
 * них канал не несёт. Id, имена и адреса вымышлены: живым данным и
 * секретам в тестах места нет.
 *
 * Сервер — общий стенд модуля (`./testing.ts`).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { startFakeKaiten } from "./testing.ts";
import { type KaitenAccess, KaitenError } from "./mod.ts";
import {
  getCurrentUser,
  listBoardColumns,
  listBoardLanes,
  listCustomProperties,
  listSpaces,
  listUserActivities,
} from "./refs.ts";

const API_KEY = "proba-kaiten-key-Q3z8Nw";
const BOARD_ID = 501;
const CARD_ID = 65634936;

function accessTo(baseUrl: string): KaitenAccess {
  return { baseUrl, apiKey: API_KEY };
}

async function readFixture(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(`testdata/${name}`, import.meta.url));
}

// --- 1. владелец токена -----------------------------------------------------

Deno.test("вызов 1: владелец токена", async (t) => {
  await t.step("запрос без query и тела, все четыре поля", async () => {
    const { baseUrl, seen, stop } = startFakeKaiten(() =>
      Response.json({
        id: 77,
        full_name: "Иванов Иван",
        username: "ivanov",
        email: "ivanov@proba.test",
      })
    );
    try {
      const user = await getCurrentUser(accessTo(baseUrl));

      assertEquals(seen[0].method, "GET");
      assertEquals(seen[0].pathname, "/api/latest/users/current");
      assertEquals(seen[0].search, "");
      assertEquals(seen[0].body, "");
      assertEquals(user, {
        id: 77,
        fullName: "Иванов Иван",
        username: "ivanov",
        email: "ivanov@proba.test",
      });
    } finally {
      await stop();
    }
  });

  await t.step("отсутствующее поле — пустая строка, не `null`", async () => {
    const { baseUrl, stop } = startFakeKaiten(() => Response.json({ id: 77 }));
    try {
      assertEquals(await getCurrentUser(accessTo(baseUrl)), {
        id: 77,
        fullName: "",
        username: "",
        email: "",
      });
    } finally {
      await stop();
    }
  });

  await t.step("ответ не пользователь — ошибка запроса", async (t2) => {
    // Вызов обещает ровно один объект с непустым `id`: и объект без него,
    // и тело другой формы — отказ, а не «пользователя нет».
    for (const body of [{ full_name: "Иванов Иван" }, [], "нет"]) {
      await t2.step(JSON.stringify(body), async () => {
        const { baseUrl, stop } = startFakeKaiten(() => Response.json(body));
        try {
          await assertRejects(
            () => getCurrentUser(accessTo(baseUrl)),
            KaitenError,
            "kaiten GET /users/current: ответ не пользователь",
          );
        } finally {
          await stop();
        }
      });
    }
  });
});

// --- 2. лента действий ------------------------------------------------------

/** Карточка на момент действия: форма — элемент `GET /cards`. */
const ACTIVITY_CARD = {
  id: CARD_ID,
  title: "Отчёт за июль",
  state: 2,
  condition: 1,
  due_date: null,
  updated: "2026-07-20T09:00:00.000Z",
  board_id: BOARD_ID,
  column_id: 601,
  lane_id: 701,
  archived: false,
  last_moved_at: null,
  time_spent_sum: 240,
  board: { id: BOARD_ID, title: "Разработка", spaces: [{ title: "Продукт" }] },
  column: { title: "В работе" },
  lane: { title: "Основная" },
  type: { name: "Задача" },
};

const PARSED_ACTIVITY_CARD = {
  id: CARD_ID,
  title: "Отчёт за июль",
  state: 2,
  condition: 1,
  dueDate: null,
  updated: "2026-07-20T09:00:00.000Z",
  boardId: BOARD_ID,
  columnId: 601,
  laneId: 701,
  archived: false,
  lastMovedAt: null,
  timeSpentSum: 240,
  boardTitle: "Разработка",
  spaceTitles: ["Продукт"],
  columnTitle: "В работе",
  laneTitle: "Основная",
  typeName: "Задача",
};

Deno.test("вызов 2: лента действий — запрос и разбор", async () => {
  const { baseUrl, seen, stop } = startFakeKaiten(() =>
    Response.json([
      {
        id: "a-1",
        created: "2026-07-20T10:00:00.000Z",
        action: "card_move",
        card_id: CARD_ID,
        card: ACTIVITY_CARD,
      },
      // Действие без карточки: `card` отсутствует целиком.
      {
        id: "a-2",
        created: "2026-07-19T10:00:00.000Z",
        action: "user_login",
        card_id: null,
      },
    ])
  );
  try {
    const feed = await listUserActivities(accessTo(baseUrl), {
      actions: ["card_move", "card_add"],
      maxPages: 3,
    });

    assertEquals(seen[0].method, "GET");
    assertEquals(seen[0].pathname, "/api/latest/users/current/activities");
    // Типы действий уходят CSV-списком; нижняя граница даты в запрос не
    // попадает вовсе — серверного фильтра по дате у эндпоинта нет.
    assertEquals(
      seen[0].search,
      "?actions=card_move%2Ccard_add&offset=0&limit=100" +
        "&cursor_created=&cursor_id=",
    );
    assertEquals(feed, [
      {
        id: "a-1",
        created: "2026-07-20T10:00:00.000Z",
        action: "card_move",
        cardId: CARD_ID,
        card: PARSED_ACTIVITY_CARD,
      },
      {
        id: "a-2",
        created: "2026-07-19T10:00:00.000Z",
        action: "user_login",
        cardId: null,
        card: null,
      },
    ]);
  } finally {
    await stop();
  }
});

Deno.test("вызов 2: нижняя граница даты не уходит в запрос", async () => {
  const { baseUrl, seen, stop } = startFakeKaiten(() => Response.json([]));
  try {
    await listUserActivities(accessTo(baseUrl), {
      actions: ["card_move"],
      maxPages: 3,
      minCreated: "2026-07-01T00:00:00.000Z",
    });

    assertEquals(
      seen[0].search,
      "?actions=card_move&offset=0&limit=100&cursor_created=&cursor_id=",
    );
  } finally {
    await stop();
  }
});

Deno.test("вызов 2: элементы без строкового `id` в выдачу не попадают", async () => {
  const { baseUrl, stop } = startFakeKaiten(() =>
    Response.json([
      "мусор",
      { created: "2026-07-20T10:00:00.000Z", action: "card_move" },
      // Числовой `id` строковым курсором не является.
      { id: 7, action: "card_move" },
      { id: "a-1", action: "card_move" },
    ])
  );
  try {
    const feed = await listUserActivities(accessTo(baseUrl), {
      actions: ["card_move"],
      maxPages: 1,
    });

    assertEquals(feed, [{
      id: "a-1",
      created: null,
      action: "card_move",
      cardId: null,
      card: null,
    }]);
  } finally {
    await stop();
  }
});

Deno.test("вызов 2: не-2xx — ошибка общего формата без query", async () => {
  const { baseUrl, stop } = startFakeKaiten(() =>
    new Response("limit is too large", { status: 400 })
  );
  try {
    await assertRejects(
      () =>
        listUserActivities(accessTo(baseUrl), {
          actions: ["card_move"],
          maxPages: 1,
        }),
      KaitenError,
      "kaiten GET /users/current/activities -> 400: limit is too large",
    );
  } finally {
    await stop();
  }
});

// --- 3. пространства --------------------------------------------------------

Deno.test("вызов 3: пространства с вложенными досками (golden)", async () => {
  const { baseUrl, seen, stop } = startFakeKaiten(async () =>
    new Response(await readFixture("spaces-ok.json"))
  );
  try {
    const spaces = await listSpaces(accessTo(baseUrl));

    assertEquals(seen[0].method, "GET");
    assertEquals(seen[0].pathname, "/api/latest/spaces");
    assertEquals(seen[0].search, "");
    assertEquals(spaces, [
      {
        id: 101,
        title: "Разработка",
        archived: false,
        boards: [
          { id: 501, spaceId: 101, title: "Основная доска" },
          { id: 502, spaceId: 101, title: "Баги" },
        ],
      },
      {
        id: 102,
        title: "Архивное пространство",
        archived: true,
        boards: [],
      },
    ]);
  } finally {
    await stop();
  }
});

Deno.test("вызов 3: доска без `space_id` принадлежит родителю", async () => {
  const { baseUrl, stop } = startFakeKaiten(() =>
    Response.json([
      {
        id: 101,
        title: "Разработка",
        boards: [
          { id: 501, title: "Без принадлежности" },
          "мусор",
          { title: "без id" },
        ],
      },
      // Ни строка, ни объект без числового id пространством не являются.
      "мусор",
      { title: "без id" },
    ])
  );
  try {
    assertEquals(await listSpaces(accessTo(baseUrl)), [{
      id: 101,
      title: "Разработка",
      archived: false,
      boards: [{ id: 501, spaceId: 101, title: "Без принадлежности" }],
    }]);
  } finally {
    await stop();
  }
});

// --- 4. дорожки -------------------------------------------------------------

Deno.test("вызов 4: дорожки одной доски (golden)", async () => {
  const { baseUrl, seen, stop } = startFakeKaiten(async () =>
    new Response(await readFixture("lanes-ok.json"))
  );
  try {
    const lanes = await listBoardLanes(accessTo(baseUrl), BOARD_ID);

    assertEquals(seen[0].method, "GET");
    assertEquals(seen[0].pathname, `/api/latest/boards/${BOARD_ID}/lanes`);
    assertEquals(seen[0].body, "");
    assertEquals(lanes, [
      { id: 9001, boardId: BOARD_ID, title: "Обычные" },
      { id: 9002, boardId: BOARD_ID, title: "Срочные" },
    ]);
  } finally {
    await stop();
  }
});

Deno.test("вызов 4: элементы без числовых `id` и `board_id` отбрасываются", async () => {
  const { baseUrl, stop } = startFakeKaiten(() =>
    Response.json([
      "мусор",
      { id: 9001, title: "Без доски" },
      { board_id: BOARD_ID, title: "Без id" },
      { id: 9002, board_id: BOARD_ID },
    ])
  );
  try {
    assertEquals(await listBoardLanes(accessTo(baseUrl), BOARD_ID), [
      // Названия у элемента нет — пустая строка, а не отказ разбора.
      { id: 9002, boardId: BOARD_ID, title: "" },
    ]);
  } finally {
    await stop();
  }
});

Deno.test("вызов 4: несуществующая доска — ошибка не-2xx", async () => {
  const { baseUrl, stop } = startFakeKaiten(() =>
    new Response("board not found", { status: 404 })
  );
  try {
    await assertRejects(
      () => listBoardLanes(accessTo(baseUrl), 999),
      KaitenError,
      "kaiten GET /boards/999/lanes -> 404: board not found",
    );
  } finally {
    await stop();
  }
});

// --- 5. колонки -------------------------------------------------------------

Deno.test("вызов 5: колонки одной доски (golden)", async () => {
  const { baseUrl, seen, stop } = startFakeKaiten(async () =>
    new Response(await readFixture("columns-ok.json"))
  );
  try {
    const columns = await listBoardColumns(accessTo(baseUrl), BOARD_ID);

    assertEquals(seen[0].method, "GET");
    assertEquals(seen[0].pathname, `/api/latest/boards/${BOARD_ID}/columns`);
    assertEquals(columns, [
      { id: 7001, boardId: BOARD_ID, title: "Очередь", sortOrder: 1 },
      { id: 7002, boardId: BOARD_ID, title: "В работе", sortOrder: 2 },
      { id: 7003, boardId: BOARD_ID, title: "Готово", sortOrder: 3 },
    ]);
  } finally {
    await stop();
  }
});

Deno.test("вызов 5: дробный вес и его отсутствие", async () => {
  const { baseUrl, stop } = startFakeKaiten(() =>
    Response.json([
      { id: 7001, board_id: BOARD_ID, title: "Очередь", sort_order: 1.5 },
      { id: 7002, board_id: BOARD_ID, title: "Готово", sort_order: null },
      // Ни строка, ни объект без числового `board_id` колонкой не являются.
      "мусор",
      { id: 7003, title: "Ничья" },
    ])
  );
  try {
    assertEquals(await listBoardColumns(accessTo(baseUrl), BOARD_ID), [
      { id: 7001, boardId: BOARD_ID, title: "Очередь", sortOrder: 1.5 },
      { id: 7002, boardId: BOARD_ID, title: "Готово", sortOrder: null },
    ]);
  } finally {
    await stop();
  }
});

// --- 6. кастомные поля ------------------------------------------------------

Deno.test("вызов 6: определения кастомных полей", async () => {
  const { baseUrl, seen, stop } = startFakeKaiten(() =>
    Response.json([
      { id: 610303, name: "9. AI-артефакт", type: "file" },
      { id: 610304, name: "Гипотеза", type: null },
      "мусор",
      { name: "без id" },
    ])
  );
  try {
    const properties = await listCustomProperties(accessTo(baseUrl));

    assertEquals(seen[0].method, "GET");
    assertEquals(seen[0].pathname, "/api/latest/company/custom-properties");
    assertEquals(seen[0].search, "");
    assertEquals(properties, [
      { id: 610303, name: "9. AI-артефакт", type: "file" },
      { id: 610304, name: "Гипотеза", type: null },
    ]);
  } finally {
    await stop();
  }
});

Deno.test("вызов 6: компания без кастомных полей — пустой список", async () => {
  const { baseUrl, stop } = startFakeKaiten(() => Response.json([]));
  try {
    assertEquals(await listCustomProperties(accessTo(baseUrl)), []);
  } finally {
    await stop();
  }
});
