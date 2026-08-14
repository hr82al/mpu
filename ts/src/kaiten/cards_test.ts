/**
 * Каталог карточки и её содержимого
 * (`docs/specs/platform/kaiten-api-cards.md`): по паре «запрос → ответ»
 * на каждый из 14 вызовов, ошибка не-2xx и границы раздела
 * «Golden-примеры». Вызывающего кода у каталога в этой волне нет (команд
 * `mpu kiten` в порции нет), поэтому форму отправленного запроса и разбор
 * ответа держат именно эти тесты.
 *
 * Фикстуры синтетические и объявлены здесь же: канал спецификаций
 * golden-файлов для этого каталога не несёт, а в `testdata/` лежат только
 * копии канала (`fixtures_test.ts` стережёт, что лишних копий там нет).
 * Id, имена и адреса вымышлены — живым данным и секретам в тестах места
 * нет.
 *
 * Сервер — общий стенд модуля (`./testing.ts`).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { startFakeKaiten } from "./testing.ts";
import { type KaitenAccess, KaitenError } from "./mod.ts";
import {
  createCardChecklist,
  createCardComment,
  createCardCommentWithFiles,
  createChecklistItem,
  deleteCardFile,
  getCard,
  listCardComments,
  listCardLocationHistory,
  listCards,
  moveCard,
  updateCardDescription,
  updateCardProperties,
  updateChecklistItem,
  uploadCustomPropertyFile,
} from "./cards.ts";

const API_KEY = "proba-kaiten-key-Q3z8Nw";
const CARD_ID = 65634936;

function accessTo(baseUrl: string): KaitenAccess {
  return { baseUrl, apiKey: API_KEY };
}

/** Участник карточки: у него, в отличие от автора комментария, есть почта. */
const MEMBER = {
  id: 77,
  full_name: "Иванов Иван",
  email: "ivanov@proba.test",
  username: "ivanov",
};

const OWNER = {
  id: 78,
  full_name: "Петров Пётр",
  email: "petrov@proba.test",
  username: "petrov",
};

/** Файл, приложенный к комментарию: `comment_id` показывает владельца. */
const CARD_FILE = {
  id: 4001,
  url: "https://kaiten.proba.test/files/4001",
  name: "otchet.md",
  mime_type: "text/markdown",
  comment_id: 3001,
  card_cover: false,
  custom_property_id: null,
};

const PARSED_CARD_FILE = {
  id: 4001,
  url: "https://kaiten.proba.test/files/4001",
  name: "otchet.md",
  mimeType: "text/markdown",
  commentId: 3001,
  cardCover: false,
  customPropertyId: null,
};

/**
 * Пункт чек-листа, как его отдаёт сервер: сверх формы каталога он несёт
 * служебные поля, и ни одно из них в разобранный пункт не входит.
 */
const CHECKLIST_ITEM = {
  id: 2101,
  text: "свести цифры",
  checked: false,
  sort_order: 1.5,
  created: "2026-07-01T07:05:00.000Z",
  updated: "2026-07-01T07:05:00.000Z",
  checked_at: null,
  checked_by_id: null,
  deleted: false,
  due_date: null,
  responsible_id: null,
};

const PARSED_CHECKLIST_ITEM = {
  id: 2101,
  text: "свести цифры",
  checked: false,
  sortOrder: 1.5,
};

/** Полная карточка: ответ вызовов 2, 6, 7 и 8. */
const CARD = {
  id: CARD_ID,
  key: "PRO-42",
  title: "Отчёт за июль",
  state: 2,
  condition: 1,
  due_date: "2026-07-31T21:00:00.000Z",
  size_text: "M",
  created: "2026-07-01T07:00:00.000Z",
  updated: "2026-07-20T09:00:00.000Z",
  description: "## Что сделано\n\n- [ ] свести цифры\n",
  time_spent_sum: 240,
  board: { id: 501, title: "Разработка" },
  column: { id: 601, title: "В работе" },
  lane: { title: "Основная" },
  type: { name: "Задача" },
  owner: OWNER,
  timer: {
    id: 555,
    card_id: CARD_ID,
    card_title: "Отчёт за июль",
    comment: "работа над отчётом",
    started_at: "2026-07-20T10:00:00.000+03:00",
    finished_at: null,
    card_time_log_id: null,
  },
  // Тег на проводе — объект; значимо в нём только имя.
  tags: [{ name: "отчётность" }, { name: "июль" }],
  members: [MEMBER],
  files: [CARD_FILE],
  properties: { id_610303: "https://kaiten.proba.test/files/4001" },
  checklists: [{ id: 2001, name: "Проверки", items: [CHECKLIST_ITEM] }],
};

const PARSED_CARD = {
  id: CARD_ID,
  key: "PRO-42",
  title: "Отчёт за июль",
  state: 2,
  condition: 1,
  dueDate: "2026-07-31T21:00:00.000Z",
  sizeText: "M",
  created: "2026-07-01T07:00:00.000Z",
  updated: "2026-07-20T09:00:00.000Z",
  description: "## Что сделано\n\n- [ ] свести цифры\n",
  timeSpentSum: 240,
  boardId: 501,
  boardTitle: "Разработка",
  columnId: 601,
  columnTitle: "В работе",
  laneTitle: "Основная",
  typeName: "Задача",
  owner: {
    id: 78,
    fullName: "Петров Пётр",
    email: "petrov@proba.test",
    username: "petrov",
  },
  timer: {
    id: 555,
    cardId: CARD_ID,
    cardTitle: "Отчёт за июль",
    comment: "работа над отчётом",
    startedAt: "2026-07-20T10:00:00.000+03:00",
    finishedAt: null,
    cardTimeLogId: null,
  },
  tags: ["отчётность", "июль"],
  members: [{
    id: 77,
    fullName: "Иванов Иван",
    email: "ivanov@proba.test",
    username: "ivanov",
  }],
  files: [PARSED_CARD_FILE],
  properties: { id_610303: "https://kaiten.proba.test/files/4001" },
  checklists: [{
    id: 2001,
    name: "Проверки",
    items: [PARSED_CHECKLIST_ITEM],
  }],
};

/** Комментарий: у автора приходят только id, полное имя и логин. */
const COMMENT = {
  id: 3001,
  text: "свёл цифры, смотри **вложения**",
  created: "2026-07-20T09:30:00.000Z",
  author: { id: 77, full_name: "Иванов Иван", username: "ivanov" },
};

const PARSED_COMMENT = {
  id: 3001,
  text: "свёл цифры, смотри **вложения**",
  created: "2026-07-20T09:30:00.000Z",
  // Почты в форме автора комментария нет — в отличие от участника карточки.
  author: { id: 77, fullName: "Иванов Иван", email: null, username: "ivanov" },
};

Deno.test("вызов 1: список карточек с фильтрами", async () => {
  // Доска приходит вложенной вместе со списком пространств: подпись места
  // собирается из них, а не из плоских полей.
  const summary = {
    id: CARD_ID,
    title: "Отчёт за июль",
    state: 2,
    condition: 1,
    due_date: "2026-07-31T21:00:00.000Z",
    updated: "2026-07-20T09:00:00.000Z",
    board_id: 501,
    column_id: 601,
    lane_id: 701,
    archived: false,
    last_moved_at: "2026-07-19T08:00:00.000Z",
    time_spent_sum: 240,
    board: {
      id: 501,
      title: "Разработка",
      spaces: [{ title: "Продукт" }, { title: "Архив" }],
    },
    column: { title: "В работе" },
    lane: { title: "Основная" },
    type: { name: "Задача" },
  };
  const { baseUrl, seen, stop } = startFakeKaiten(() =>
    Response.json([summary])
  );
  try {
    const cards = await listCards(accessTo(baseUrl), {
      memberIds: [77, 78],
      states: [1, 2],
      responsibleId: 79,
      condition: 1,
      spaceId: 301,
      boardId: 501,
      laneId: 701,
      columnId: 601,
      updatedAfter: "2026-07-01T00:00:00Z",
      updatedBefore: "2026-08-01T00:00:00Z",
    });

    assertEquals(seen[0].method, "GET");
    assertEquals(seen[0].pathname, "/api/latest/cards");
    // Ответственный — отдельная ось от участников, дорожка — единственного
    // числа: `lane_ids` сервер молча игнорирует, поэтому имя точно.
    assertEquals(
      seen[0].search,
      "?member_ids=77%2C78&responsible_id=79&condition=1&states=1%2C2" +
        "&space_id=301&board_id=501&lane_id=701&column_id=601" +
        "&updated_after=2026-07-01T00%3A00%3A00Z" +
        "&updated_before=2026-08-01T00%3A00%3A00Z&limit=100&offset=0",
    );
    assertEquals(cards, [{
      id: CARD_ID,
      title: "Отчёт за июль",
      state: 2,
      condition: 1,
      dueDate: "2026-07-31T21:00:00.000Z",
      updated: "2026-07-20T09:00:00.000Z",
      boardId: 501,
      columnId: 601,
      laneId: 701,
      archived: false,
      lastMovedAt: "2026-07-19T08:00:00.000Z",
      timeSpentSum: 240,
      boardTitle: "Разработка",
      spaceTitles: ["Продукт", "Архив"],
      columnTitle: "В работе",
      laneTitle: "Основная",
      typeName: "Задача",
    }]);
  } finally {
    await stop();
  }
});

Deno.test("вызов 1: без фильтров уходят только лимит и смещение", async () => {
  const { baseUrl, seen, stop } = startFakeKaiten(() => Response.json([]));
  try {
    assertEquals(await listCards(accessTo(baseUrl)), []);

    assertEquals(seen[0].search, "?limit=100&offset=0");
  } finally {
    await stop();
  }
});

Deno.test("вызов 1: элементы не той формы в выдачу не попадают", async () => {
  const { baseUrl, stop } = startFakeKaiten(() =>
    Response.json(["мусор", { title: "без id" }, { id: 7 }])
  );
  try {
    const cards = await listCards(accessTo(baseUrl));

    assertEquals(cards.map((card) => card.id), [7]);
    // Вложенных объектов у минимального элемента нет — подписи места пусты.
    assertEquals(cards[0].boardTitle, null);
    assertEquals(cards[0].spaceTitles, []);
    assertEquals(cards[0].columnTitle, null);
    assertEquals(cards[0].laneTitle, null);
    assertEquals(cards[0].typeName, null);
    assertEquals(cards[0].archived, false);
  } finally {
    await stop();
  }
});

Deno.test("вызов 2: карточка целиком", async () => {
  const { baseUrl, seen, stop } = startFakeKaiten(() => Response.json(CARD));
  try {
    const card = await getCard(accessTo(baseUrl), CARD_ID);

    assertEquals(seen[0].method, "GET");
    assertEquals(seen[0].pathname, `/api/latest/cards/${CARD_ID}`);
    assertEquals(seen[0].body, "");
    assertEquals(card, PARSED_CARD);
  } finally {
    await stop();
  }
});

Deno.test("вызов 2: карточка без вложенных объектов", async () => {
  const { baseUrl, stop } = startFakeKaiten(() =>
    Response.json({ id: CARD_ID })
  );
  try {
    const card = await getCard(accessTo(baseUrl), CARD_ID);

    assertEquals(card, {
      id: CARD_ID,
      key: null,
      title: "",
      state: 0,
      condition: 0,
      dueDate: null,
      sizeText: null,
      created: null,
      updated: null,
      description: null,
      timeSpentSum: null,
      boardId: null,
      boardTitle: null,
      columnId: null,
      columnTitle: null,
      laneTitle: null,
      typeName: null,
      owner: null,
      // Таймера нет — значит, у текущего пользователя он не запущен.
      timer: null,
      tags: [],
      members: [],
      files: [],
      properties: {},
      checklists: [],
    });
  } finally {
    await stop();
  }
});

Deno.test("вызов 2: мусор во вложенных списках отбрасывается", async () => {
  const { baseUrl, stop } = startFakeKaiten(() =>
    Response.json({
      ...CARD,
      // Ни один из этих элементов формой каталога не является.
      // Строкой тег на проводе не приходит: такой элемент — не тег.
      tags: [{ name: "отчётность" }, "июль", { name: 7 }, 7, null],
      members: ["мусор", { full_name: "без id" }, MEMBER],
      files: ["мусор", { url: "без id" }, CARD_FILE],
      checklists: ["мусор", { name: "без id" }, {
        id: 2001,
        name: "Проверки",
        items: ["мусор", CHECKLIST_ITEM],
      }],
      properties: { id_610303: "готово", id_610304: null, id_610305: 7 },
      timer: { started_at: "2026-07-20T10:00:00.000+03:00" },
    })
  );
  try {
    const card = await getCard(accessTo(baseUrl), CARD_ID);

    assertEquals(card.tags, ["отчётность"]);
    assertEquals(card.members.map((member) => member.id), [77]);
    assertEquals(card.files.map((file) => file.id), [4001]);
    assertEquals(card.checklists, [{
      id: 2001,
      name: "Проверки",
      items: [PARSED_CHECKLIST_ITEM],
    }]);
    // Значение поля — строка; `null` и число значением поля не считаются.
    assertEquals(card.properties, { id_610303: "готово" });
    // Таймер без своего id таймером не является.
    assertEquals(card.timer, null);
  } finally {
    await stop();
  }
});

Deno.test("вызов 3: комментарии карточки", async (t) => {
  await t.step("хронологически, с GFM-разметкой", async () => {
    const second = {
      id: 3002,
      text: "> цитата\n\nи вывод",
      created: "2026-07-20T10:30:00.000Z",
      author: { id: 78, full_name: "Петров Пётр", username: "petrov" },
    };
    const { baseUrl, seen, stop } = startFakeKaiten(() =>
      Response.json([COMMENT, second])
    );
    try {
      const comments = await listCardComments(accessTo(baseUrl), CARD_ID);

      assertEquals(seen[0].method, "GET");
      assertEquals(seen[0].pathname, `/api/latest/cards/${CARD_ID}/comments`);
      assertEquals(comments, [
        PARSED_COMMENT,
        {
          id: 3002,
          text: "> цитата\n\nи вывод",
          created: "2026-07-20T10:30:00.000Z",
          author: {
            id: 78,
            fullName: "Петров Пётр",
            email: null,
            username: "petrov",
          },
        },
      ]);
    } finally {
      await stop();
    }
  });

  await t.step("карточка без комментариев — пустой массив", async () => {
    const { baseUrl, stop } = startFakeKaiten(() => Response.json([]));
    try {
      assertEquals(await listCardComments(accessTo(baseUrl), CARD_ID), []);
    } finally {
      await stop();
    }
  });

  await t.step("элементы не той формы пропускаются", async () => {
    const { baseUrl, stop } = startFakeKaiten(() =>
      Response.json(["мусор", { text: "без id" }, { id: 3003, author: 7 }])
    );
    try {
      assertEquals(await listCardComments(accessTo(baseUrl), CARD_ID), [{
        id: 3003,
        text: "",
        created: null,
        // Автор пришёл не объектом — автора у комментария нет.
        author: null,
      }]);
    } finally {
      await stop();
    }
  });
});

Deno.test("вызов 4: комментарий без вложений — JSON-тело", async () => {
  const { baseUrl, seen, stop } = startFakeKaiten(() =>
    Response.json(COMMENT, { status: 201 })
  );
  try {
    const comment = await createCardComment(
      accessTo(baseUrl),
      CARD_ID,
      "свёл цифры, смотри **вложения**",
    );

    assertEquals(seen[0].method, "POST");
    assertEquals(seen[0].pathname, `/api/latest/cards/${CARD_ID}/comments`);
    assertEquals(seen[0].contentType, "application/json");
    assertEquals(JSON.parse(seen[0].body), {
      text: "свёл цифры, смотри **вложения**",
    });
    assertEquals(comment, PARSED_COMMENT);
  } finally {
    await stop();
  }
});

Deno.test("вызов 5: комментарий с файлами — multipart-тело", async () => {
  const { baseUrl, seen, stop } = startFakeKaiten(() =>
    Response.json(COMMENT, { status: 201 })
  );
  try {
    const comment = await createCardCommentWithFiles(
      accessTo(baseUrl),
      CARD_ID,
      "свёл цифры, смотри **вложения**",
      [
        { name: "otchet.md", bytes: new TextEncoder().encode("# отчёт\n") },
        { name: "dannye.csv", bytes: new TextEncoder().encode("a,b\n1,2\n") },
      ],
    );

    assertEquals(seen[0].method, "POST");
    assertEquals(seen[0].pathname, `/api/latest/cards/${CARD_ID}/comments`);

    const contentType = seen[0].contentType ?? "";
    const prefix = "multipart/form-data; boundary=";
    assertEquals(contentType.startsWith(prefix), true, contentType);
    const boundary = contentType.slice(prefix.length);
    // Три part'а: текст и по одному на файл — имя поля `files[]` на каждом.
    assertEquals(
      seen[0].body,
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="text"',
        "",
        "свёл цифры, смотри **вложения**",
        `--${boundary}`,
        'Content-Disposition: form-data; name="files[]"; filename="otchet.md"',
        "Content-Type: text/markdown",
        "",
        "# отчёт\n",
        `--${boundary}`,
        'Content-Disposition: form-data; name="files[]"; filename="dannye.csv"',
        "Content-Type: text/csv",
        "",
        "a,b\n1,2\n",
        `--${boundary}--`,
      ].join("\r\n"),
    );
    // Ответ — «Комментарий»: файлов эта форма не несёт, их привязка
    // наблюдаема полной карточкой (вызов 2), где у файла стоит `comment_id`.
    assertEquals(comment, PARSED_COMMENT);
  } finally {
    await stop();
  }
});

Deno.test("вызов 6: перемещение — только заданные оси", async (t) => {
  await t.step("колонка и дорожка без доски", async () => {
    const { baseUrl, seen, stop } = startFakeKaiten(() => Response.json(CARD));
    try {
      const card = await moveCard(accessTo(baseUrl), CARD_ID, {
        columnId: 602,
        laneId: 702,
      });

      assertEquals(seen[0].method, "PATCH");
      assertEquals(seen[0].pathname, `/api/latest/cards/${CARD_ID}`);
      // Доска не задана — ключа `board_id` в теле нет вовсе.
      assertEquals(JSON.parse(seen[0].body), {
        column_id: 602,
        lane_id: 702,
      });
      assertEquals(card, PARSED_CARD);
    } finally {
      await stop();
    }
  });

  await t.step("все три оси разом", async () => {
    const { baseUrl, seen, stop } = startFakeKaiten(() => Response.json(CARD));
    try {
      await moveCard(accessTo(baseUrl), CARD_ID, {
        boardId: 502,
        columnId: 602,
        laneId: 702,
      });

      assertEquals(JSON.parse(seen[0].body), {
        board_id: 502,
        column_id: 602,
        lane_id: 702,
      });
    } finally {
      await stop();
    }
  });
});

Deno.test("вызов 7: описание заменяется целиком", async () => {
  const { baseUrl, seen, stop } = startFakeKaiten(() => Response.json(CARD));
  try {
    await updateCardDescription(
      accessTo(baseUrl),
      CARD_ID,
      "## Что сделано\n\n- [ ] свести цифры\n",
    );

    assertEquals(seen[0].method, "PATCH");
    assertEquals(seen[0].pathname, `/api/latest/cards/${CARD_ID}`);
    // `- [ ]` в описании — обычный пункт списка: интерактивных чекбоксов
    // редактор описания не поддерживает, они есть только у чек-листа.
    assertEquals(JSON.parse(seen[0].body), {
      description: "## Что сделано\n\n- [ ] свести цифры\n",
    });
  } finally {
    await stop();
  }
});

Deno.test("вызов 8: очистка кастомного поля значением null", async () => {
  const { baseUrl, seen, stop } = startFakeKaiten(() => Response.json(CARD));
  try {
    await updateCardProperties(accessTo(baseUrl), CARD_ID, {
      id_610303: null,
      id_610304: "готово",
    });

    assertEquals(seen[0].method, "PATCH");
    assertEquals(seen[0].pathname, `/api/latest/cards/${CARD_ID}`);
    // `null` — валидная операция очистки поля, а не пропуск ключа.
    assertEquals(JSON.parse(seen[0].body), {
      properties: { id_610303: null, id_610304: "готово" },
    });
  } finally {
    await stop();
  }
});

Deno.test("вызов 9: история перемещений", async (t) => {
  await t.step("записи разных авторов", async () => {
    const { baseUrl, seen, stop } = startFakeKaiten(() =>
      Response.json([
        {
          card_id: CARD_ID,
          column_id: 601,
          lane_id: 701,
          author_id: 77,
          author_name: "Иванов Иван",
          changed: "2026-07-19T08:00:00.000Z",
        },
        {
          card_id: CARD_ID,
          column_id: 602,
          lane_id: null,
          author_id: 78,
          author_name: "Петров Пётр",
          changed: "2026-07-20T11:00:00.000Z",
        },
      ])
    );
    try {
      const history = await listCardLocationHistory(accessTo(baseUrl), CARD_ID);

      assertEquals(seen[0].method, "GET");
      assertEquals(
        seen[0].pathname,
        `/api/latest/cards/${CARD_ID}/location-history`,
      );
      assertEquals(history, [
        {
          cardId: CARD_ID,
          columnId: 601,
          laneId: 701,
          authorId: 77,
          authorName: "Иванов Иван",
          changed: "2026-07-19T08:00:00.000Z",
        },
        {
          cardId: CARD_ID,
          columnId: 602,
          laneId: null,
          authorId: 78,
          authorName: "Петров Пётр",
          changed: "2026-07-20T11:00:00.000Z",
        },
      ]);
    } finally {
      await stop();
    }
  });

  await t.step("карточка без перемещений — пустой массив", async () => {
    const { baseUrl, stop } = startFakeKaiten(() => Response.json([]));
    try {
      assertEquals(
        await listCardLocationHistory(accessTo(baseUrl), CARD_ID),
        [],
      );
    } finally {
      await stop();
    }
  });

  await t.step("элементы без карточки записью не считаются", async () => {
    const { baseUrl, stop } = startFakeKaiten(() =>
      Response.json(["мусор", { column_id: 601 }, { card_id: CARD_ID }])
    );
    try {
      assertEquals(await listCardLocationHistory(accessTo(baseUrl), CARD_ID), [{
        cardId: CARD_ID,
        columnId: null,
        laneId: null,
        authorId: null,
        authorName: null,
        changed: null,
      }]);
    } finally {
      await stop();
    }
  });
});

Deno.test("вызов 10: чек-лист сразу после создания пуст", async () => {
  const { baseUrl, seen, stop } = startFakeKaiten(() =>
    Response.json({ id: 2001, name: "Проверки", items: [] }, { status: 201 })
  );
  try {
    const checklist = await createCardChecklist(
      accessTo(baseUrl),
      CARD_ID,
      "Проверки",
    );

    assertEquals(seen[0].method, "POST");
    assertEquals(seen[0].pathname, `/api/latest/cards/${CARD_ID}/checklists`);
    assertEquals(JSON.parse(seen[0].body), { name: "Проверки" });
    // Пункты добавляются отдельными вызовами 11.
    assertEquals(checklist, { id: 2001, name: "Проверки", items: [] });
  } finally {
    await stop();
  }
});

Deno.test("вызов 11: пункт чек-листа", async (t) => {
  await t.step("без sort_order — сервер ставит пункт в конец", async () => {
    const { baseUrl, seen, stop } = startFakeKaiten(() =>
      Response.json(CHECKLIST_ITEM, { status: 201 })
    );
    try {
      const item = await createChecklistItem(
        accessTo(baseUrl),
        CARD_ID,
        2001,
        { text: "свести цифры", checked: false },
      );

      assertEquals(seen[0].method, "POST");
      assertEquals(
        seen[0].pathname,
        `/api/latest/cards/${CARD_ID}/checklists/2001/items`,
      );
      // Ключа `sort_order` в теле нет вовсе — иначе позиция была бы задана.
      assertEquals(JSON.parse(seen[0].body), {
        text: "свести цифры",
        checked: false,
      });
      // Служебные поля пункта в форму каталога не входят.
      assertEquals(item, PARSED_CHECKLIST_ITEM);
    } finally {
      await stop();
    }
  });

  await t.step("явный sort_order фиксирует позицию", async () => {
    const { baseUrl, seen, stop } = startFakeKaiten(() =>
      Response.json({ ...CHECKLIST_ITEM, sort_order: 0.5 }, { status: 201 })
    );
    try {
      const item = await createChecklistItem(
        accessTo(baseUrl),
        CARD_ID,
        2001,
        { text: "свести цифры", checked: false, sortOrder: 0.5 },
      );

      assertEquals(JSON.parse(seen[0].body), {
        text: "свести цифры",
        checked: false,
        sort_order: 0.5,
      });
      assertEquals(item.sortOrder, 0.5);
    } finally {
      await stop();
    }
  });
});

Deno.test("вызов 12: отметка пункта — ответ несёт обновлённый пункт", async () => {
  const { baseUrl, seen, stop } = startFakeKaiten(() =>
    Response.json({ ...CHECKLIST_ITEM, checked: true })
  );
  try {
    const item = await updateChecklistItem(
      accessTo(baseUrl),
      CARD_ID,
      2001,
      2101,
      { checked: true },
    );

    assertEquals(seen[0].method, "PATCH");
    assertEquals(
      seen[0].pathname,
      `/api/latest/cards/${CARD_ID}/checklists/2001/items/2101`,
    );
    assertEquals(JSON.parse(seen[0].body), { checked: true });
    // Тот же пункт с новым `checked` и неизменным весом сортировки.
    assertEquals(item, { ...PARSED_CHECKLIST_ITEM, checked: true });
  } finally {
    await stop();
  }
});

Deno.test("вызов 13: файл в кастомное поле — multipart-тело", async () => {
  const uploaded = {
    id: 4002,
    url: "https://kaiten.proba.test/files/4002",
    name: "artefakt.md",
    mime_type: "text/markdown",
    comment_id: null,
    card_cover: false,
    custom_property_id: 610303,
  };
  const { baseUrl, seen, stop } = startFakeKaiten(() =>
    Response.json(uploaded, { status: 201 })
  );
  try {
    const file = await uploadCustomPropertyFile(
      accessTo(baseUrl),
      CARD_ID,
      610303,
      { name: "artefakt.md", bytes: new TextEncoder().encode("# артефакт\n") },
    );

    assertEquals(seen[0].method, "PUT");
    assertEquals(
      seen[0].pathname,
      `/api/latest/cards/${CARD_ID}/custom-properties/610303/files`,
    );

    const contentType = seen[0].contentType ?? "";
    const prefix = "multipart/form-data; boundary=";
    assertEquals(contentType.startsWith(prefix), true, contentType);
    const boundary = contentType.slice(prefix.length);
    // Одно поле `file` — в отличие от `files[]` вызова 5.
    assertEquals(
      seen[0].body,
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="artefakt.md"',
        "Content-Type: text/markdown",
        "",
        "# артефакт\n",
        `--${boundary}--`,
      ].join("\r\n"),
    );
    // Привязка к полю видна в ответе: `custom_property_id` равен id поля.
    assertEquals(file, {
      id: 4002,
      url: "https://kaiten.proba.test/files/4002",
      name: "artefakt.md",
      mimeType: "text/markdown",
      commentId: null,
      cardCover: false,
      customPropertyId: 610303,
    });
  } finally {
    await stop();
  }
});

Deno.test("вызов 14: удаление файла — пустое тело ответа", async () => {
  const { baseUrl, seen, stop } = startFakeKaiten(() =>
    new Response(null, { status: 204 })
  );
  try {
    await deleteCardFile(accessTo(baseUrl), CARD_ID, 4001);

    assertEquals(seen[0].method, "DELETE");
    assertEquals(seen[0].pathname, `/api/latest/cards/${CARD_ID}/files/4001`);
    assertEquals(seen[0].body, "");
  } finally {
    await stop();
  }
});

Deno.test("несуществующая карточка — 404 в общем формате транспорта", async () => {
  const { baseUrl, stop } = startFakeKaiten(() =>
    new Response('{"message":"Card not found"}', { status: 404 })
  );
  try {
    await assertRejects(
      () => moveCard(accessTo(baseUrl), 1, { columnId: 602 }),
      KaitenError,
      'kaiten PATCH /cards/1 -> 404: {"message":"Card not found"}',
    );
  } finally {
    await stop();
  }
});

Deno.test("ответ одиночного вызова не той формы — ошибка запроса", async (t) => {
  await t.step("карточка: ответ не объект", async () => {
    const { baseUrl, stop } = startFakeKaiten(() => Response.json([]));
    try {
      await assertRejects(
        () => getCard(accessTo(baseUrl), CARD_ID),
        KaitenError,
        `kaiten GET /cards/${CARD_ID}: ответ не карточка`,
      );
    } finally {
      await stop();
    }
  });

  await t.step("карточка: объект без id", async () => {
    const { baseUrl, stop } = startFakeKaiten(() =>
      Response.json({ title: "без id" })
    );
    try {
      await assertRejects(
        () => getCard(accessTo(baseUrl), CARD_ID),
        KaitenError,
        `kaiten GET /cards/${CARD_ID}: ответ не карточка`,
      );
    } finally {
      await stop();
    }
  });

  await t.step("комментарий", async () => {
    const { baseUrl, stop } = startFakeKaiten(() =>
      Response.json({ message: "nope" })
    );
    try {
      await assertRejects(
        () => createCardComment(accessTo(baseUrl), CARD_ID, "текст"),
        KaitenError,
        `kaiten POST /cards/${CARD_ID}/comments: ответ не комментарий`,
      );
    } finally {
      await stop();
    }
  });

  await t.step("пункт чек-листа", async () => {
    const { baseUrl, stop } = startFakeKaiten(() =>
      Response.json({ message: "nope" })
    );
    try {
      await assertRejects(
        () =>
          updateChecklistItem(accessTo(baseUrl), CARD_ID, 2001, 2101, {
            checked: true,
          }),
        KaitenError,
        `kaiten PATCH /cards/${CARD_ID}/checklists/2001/items/2101: ответ не пункт чек-листа`,
      );
    } finally {
      await stop();
    }
  });
});
