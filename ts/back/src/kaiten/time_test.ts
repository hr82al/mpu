/**
 * Каталог учёта времени (`docs/specs/platform/kaiten-api-time.md`): по
 * паре «запрос → ответ» на каждый из девяти вызовов. Вызывающего кода у
 * каталога в этой волне нет (команд `mpu kiten` в порции нет), поэтому
 * форму отправленного запроса и разбор ответа держат именно эти тесты.
 *
 * Фикстуры синтетические и объявлены здесь же: канал спецификаций
 * golden-файлов для этого каталога не несёт, а в `testdata/` лежат
 * только копии канала (`fixtures_test.ts` стережёт, что лишних копий
 * там нет).
 *
 * Сервер — общий стенд модуля (`./testing.ts`).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { startFakeKaiten } from "./testing.ts";
import { type KaitenAccess, KaitenError } from "./mod.ts";
import {
  createCardTimeLog,
  deleteCardTimeLog,
  listCardTimeLogs,
  listUserRoles,
  listUserTimeLogs,
  resetUserTimer,
  startUserTimer,
  stopUserTimer,
  updateCardTimeLog,
} from "./time.ts";

const API_KEY = "proba-kaiten-key-Q3z8Nw";

function accessTo(baseUrl: string): KaitenAccess {
  return { baseUrl, apiKey: API_KEY };
}

/**
 * Запись времени, как её отдаёт сервер: роль и пользователь приходят
 * вложенными объектами (у пользователя — ещё и аватарка), в форму
 * ответа входят только их имена.
 */
const TIME_LOG = {
  id: 9001,
  card_id: 65634936,
  user_id: 77,
  author_id: 78,
  role_id: 3,
  role: { id: 3, name: "Разработка" },
  user: {
    id: 77,
    full_name: "Иванов Иван",
    username: "ivanov",
    avatar: "data:image/png;base64,iVBORw0KGgo=",
  },
  time_spent: 90,
  for_date: "2026-07-20",
  comment: "правка отчёта",
};

/** Та же запись в форме порта. */
const PARSED_TIME_LOG = {
  id: 9001,
  cardId: 65634936,
  userId: 77,
  authorId: 78,
  roleId: 3,
  roleName: "Разработка",
  userName: "Иванов Иван",
  timeSpent: 90,
  forDate: "2026-07-20",
  comment: "правка отчёта",
};

/** Идущий таймер: `finished_at` и запись времени ещё пусты. */
const RUNNING_TIMER = {
  id: 555,
  card_id: 65634936,
  card_title: "Отчёт за июль",
  comment: "работа над отчётом",
  started_at: "2026-07-20T10:00:00.000+03:00",
  finished_at: null,
  card_time_log_id: null,
};

Deno.test("вызов 1: записи времени карточки", async () => {
  // Вторая запись — минимальная: ни роли, ни объекта `user` (только
  // `author`), пустой комментарий. Третий и четвёртый элементы записями
  // не являются и в выдачу не попадают.
  const minimal = {
    id: 9002,
    card_id: 65634936,
    user_id: null,
    author_id: 78,
    role_id: null,
    author: { id: 78, full_name: "Петров Пётр", username: "petrov" },
    time_spent: 30,
    for_date: "2026-07-21",
    comment: "",
  };
  const { baseUrl, seen, stop } = startFakeKaiten(() =>
    Response.json([TIME_LOG, minimal, "мусор", { card_id: 65634936 }])
  );
  try {
    const logs = await listCardTimeLogs(accessTo(baseUrl), 65634936);

    assertEquals(seen[0].method, "GET");
    assertEquals(seen[0].pathname, "/api/latest/cards/65634936/time-logs");
    assertEquals(seen[0].search, "");
    assertEquals(seen[0].body, "");
    assertEquals(logs, [
      PARSED_TIME_LOG,
      {
        id: 9002,
        cardId: 65634936,
        userId: null,
        authorId: 78,
        roleId: null,
        roleName: null,
        // Имя автора не подставляется вместо отсутствующего пользователя.
        userName: null,
        timeSpent: 30,
        forDate: "2026-07-21",
        comment: "",
      },
    ]);
  } finally {
    await stop();
  }
});

/**
 * Источник `user_name` (`kaiten-api-time.md`, вызов 1): вложенный объект
 * `user`, ключ `full_name`, при его отсутствии или пустоте — `username`.
 * Объект `author` источником имени не служит ни в каком случае: подставить
 * имя автора там, где нет пользователя, значит приписать время не тому
 * человеку.
 */
const USER_NAME_CASES: readonly {
  readonly title: string;
  readonly nested: Record<string, unknown>;
  readonly userName: string | null;
}[] = [
  {
    title: "full_name пользователя",
    nested: { user: { id: 77, full_name: "Иванов Иван", username: "ivanov" } },
    userName: "Иванов Иван",
  },
  {
    title: "пустой full_name — username",
    nested: { user: { id: 77, full_name: "", username: "ivanov" } },
    userName: "ivanov",
  },
  {
    title: "нет full_name — username",
    nested: { user: { id: 77, username: "ivanov" } },
    userName: "ivanov",
  },
  {
    title: "ни того, ни другого — null",
    nested: { user: { id: 77 } },
    userName: null,
  },
  {
    title: "пустые оба ключа — null",
    nested: { user: { id: 77, full_name: "", username: "" } },
    userName: null,
  },
  {
    title: "пользователя нет, автор есть — null, а не имя автора",
    nested: {
      author: { id: 78, full_name: "Петров Пётр", username: "petrov" },
    },
    userName: null,
  },
  {
    title: "оба объекта есть — имя пользователя, не автора",
    nested: {
      user: { id: 77, full_name: "Иванов Иван" },
      author: { id: 78, full_name: "Петров Пётр" },
    },
    userName: "Иванов Иван",
  },
];

Deno.test("вызов 1: имя пользователя — только из объекта user", async (t) => {
  // Один стенд на все случаи: шаги идут последовательно, поэтому ответ
  // выбирается по номеру уже принятого запроса.
  const { baseUrl, stop } = startFakeKaiten((seen) =>
    Response.json([{
      id: 9001,
      card_id: 65634936,
      time_spent: 90,
      for_date: "2026-07-20",
      comment: "",
      ...USER_NAME_CASES[seen.length - 1].nested,
    }])
  );
  try {
    for (const testCase of USER_NAME_CASES) {
      await t.step(testCase.title, async () => {
        const logs = await listCardTimeLogs(accessTo(baseUrl), 65634936);
        assertEquals(logs[0].userName, testCase.userName);
      });
    }
  } finally {
    await stop();
  }
});

Deno.test("вызов 2: создание записи — все четыре поля тела", async () => {
  const { baseUrl, seen, stop } = startFakeKaiten(() =>
    // На POST сервер отдаёт `for_date` полной ISO-меткой, а не датой;
    // значим только календарный день.
    Response.json({ ...TIME_LOG, for_date: "2026-07-20T00:00:00.000Z" }, {
      status: 201,
    })
  );
  try {
    const log = await createCardTimeLog(accessTo(baseUrl), 65634936, {
      forDate: "2026-07-20",
      timeSpent: 90,
      roleId: 3,
      comment: "правка отчёта",
    });

    assertEquals(seen[0].method, "POST");
    assertEquals(seen[0].pathname, "/api/latest/cards/65634936/time-logs");
    assertEquals(JSON.parse(seen[0].body), {
      for_date: "2026-07-20",
      time_spent: 90,
      role_id: 3,
      comment: "правка отчёта",
    });
    assertEquals(log, PARSED_TIME_LOG);
  } finally {
    await stop();
  }
});

Deno.test("вызов 3: обновление — только заданные поля", async (t) => {
  await t.step("подмножество полей", async () => {
    const { baseUrl, seen, stop } = startFakeKaiten(() =>
      Response.json({ ...TIME_LOG, time_spent: 120 })
    );
    try {
      const log = await updateCardTimeLog(
        accessTo(baseUrl),
        65634936,
        9001,
        { timeSpent: 120 },
      );

      assertEquals(seen[0].method, "PATCH");
      assertEquals(
        seen[0].pathname,
        "/api/latest/cards/65634936/time-logs/9001",
      );
      // Ровно одно поле: остальные сервер не трогает.
      assertEquals(JSON.parse(seen[0].body), { time_spent: 120 });
      assertEquals(log, { ...PARSED_TIME_LOG, timeSpent: 120 });
    } finally {
      await stop();
    }
  });

  await t.step("все четыре поля разом", async () => {
    const { baseUrl, seen, stop } = startFakeKaiten(() =>
      Response.json(TIME_LOG)
    );
    try {
      await updateCardTimeLog(accessTo(baseUrl), 65634936, 9001, {
        forDate: "2026-07-21",
        timeSpent: 60,
        roleId: 4,
        comment: "перенос дня",
      });

      assertEquals(JSON.parse(seen[0].body), {
        for_date: "2026-07-21",
        time_spent: 60,
        role_id: 4,
        comment: "перенос дня",
      });
    } finally {
      await stop();
    }
  });

  await t.step("ответ не той формы — ошибка запроса", async () => {
    const { baseUrl, stop } = startFakeKaiten(() =>
      Response.json({ message: "nope" })
    );
    try {
      await assertRejects(
        () =>
          updateCardTimeLog(accessTo(baseUrl), 65634936, 9001, {
            timeSpent: 120,
          }),
        KaitenError,
        "kaiten PATCH /cards/65634936/time-logs/9001: ответ не запись времени",
      );
    } finally {
      await stop();
    }
  });

  await t.step("пустая строка комментария очищает комментарий", async () => {
    const { baseUrl, seen, stop } = startFakeKaiten(() =>
      // Сервер нормализует пустую строку в `null`, а читателю снова
      // отдаёт `""`.
      Response.json({ ...TIME_LOG, comment: "" })
    );
    try {
      const log = await updateCardTimeLog(
        accessTo(baseUrl),
        65634936,
        9001,
        { comment: "" },
      );

      assertEquals(JSON.parse(seen[0].body), { comment: "" });
      assertEquals(log.comment, "");
    } finally {
      await stop();
    }
  });
});

Deno.test("вызов 4: удаление записи — успех с пустым телом", async () => {
  const { baseUrl, seen, stop } = startFakeKaiten(() =>
    new Response(null, { status: 204 })
  );
  try {
    await deleteCardTimeLog(accessTo(baseUrl), 65634936, 9001);

    assertEquals(seen[0].method, "DELETE");
    assertEquals(seen[0].pathname, "/api/latest/cards/65634936/time-logs/9001");
    assertEquals(seen[0].body, "");
  } finally {
    await stop();
  }
});

Deno.test("вызов 5: записи пользователя за окно", async (t) => {
  const card = {
    id: 65634936,
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
    board_title: "Разработка",
    space_title: "Продукт",
    column_title: "В работе",
    lane_title: "Основная",
    type_name: "Задача",
  };
  const parsedCard = {
    id: 65634936,
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
    spaceTitle: "Продукт",
    columnTitle: "В работе",
    laneTitle: "Основная",
    typeName: "Задача",
  };

  await t.step("обе границы окна уходят всегда", async () => {
    const { baseUrl, seen, stop } = startFakeKaiten(() =>
      Response.json([{ ...TIME_LOG, card }])
    );
    try {
      const logs = await listUserTimeLogs(accessTo(baseUrl), 77, {
        from: "2026-07-01",
        to: "2026-07-31",
      });

      assertEquals(seen[0].method, "GET");
      assertEquals(seen[0].pathname, "/api/latest/users/77/time-logs");
      // Без обеих границ сервер отвечает 500, а не «за всё время».
      assertEquals(seen[0].search, "?from=2026-07-01&to=2026-07-31");
      assertEquals(logs, [{ ...PARSED_TIME_LOG, card: parsedCard }]);
    } finally {
      await stop();
    }
  });

  await t.step("карточки нет — card: null", async () => {
    const { baseUrl, stop } = startFakeKaiten(() =>
      Response.json([{ ...TIME_LOG, card: null }])
    );
    try {
      const logs = await listUserTimeLogs(accessTo(baseUrl), 77, {
        from: "2026-07-01",
        to: "2026-07-31",
      });

      assertEquals(logs, [{ ...PARSED_TIME_LOG, card: null }]);
    } finally {
      await stop();
    }
  });
});

Deno.test("вызов 6: запуск таймера", async (t) => {
  await t.step("успех: тело с id — таймер запущен", async () => {
    const { baseUrl, seen, stop } = startFakeKaiten(() =>
      Response.json(RUNNING_TIMER)
    );
    try {
      const outcome = await startUserTimer(accessTo(baseUrl), {
        cardId: 65634936,
        comment: "работа над отчётом",
      });

      assertEquals(seen[0].method, "POST");
      assertEquals(seen[0].pathname, "/api/latest/user-timers");
      // Роли в теле нет: сервер её не сохраняет, тип работы выбирается
      // только при остановке.
      assertEquals(JSON.parse(seen[0].body), {
        card_id: 65634936,
        comment: "работа над отчётом",
      });
      assertEquals(outcome, {
        kind: "started",
        timer: {
          id: 555,
          cardId: 65634936,
          cardTitle: "Отчёт за июль",
          comment: "работа над отчётом",
          startedAt: "2026-07-20T10:00:00.000+03:00",
          finishedAt: null,
          cardTimeLogId: null,
        },
      });
    } finally {
      await stop();
    }
  });

  await t.step("успех: форму решает только id, прочие поля пусты", async () => {
    const { baseUrl, stop } = startFakeKaiten(() =>
      Response.json({ id: 555, card_id: null, started_at: null })
    );
    try {
      const outcome = await startUserTimer(accessTo(baseUrl), {
        cardId: 65634936,
      });

      assertEquals(outcome, {
        kind: "started",
        timer: {
          id: 555,
          cardId: null,
          cardTitle: "",
          comment: "",
          startedAt: null,
          finishedAt: null,
          cardTimeLogId: null,
        },
      });
    } finally {
      await stop();
    }
  });

  await t.step("без комментария ключа comment в теле нет", async () => {
    const { baseUrl, seen, stop } = startFakeKaiten(() =>
      Response.json(RUNNING_TIMER)
    );
    try {
      await startUserTimer(accessTo(baseUrl), { cardId: 65634936 });

      assertEquals(JSON.parse(seen[0].body), { card_id: 65634936 });
    } finally {
      await stop();
    }
  });

  await t.step("конфликт: тело без id при статусе 2xx", async () => {
    const { baseUrl, stop } = startFakeKaiten(() =>
      // Статус успеха: формы различаются составом тела, а не кодом.
      Response.json({ message: "User timer already created" }, { status: 200 })
    );
    try {
      const outcome = await startUserTimer(accessTo(baseUrl), {
        cardId: 65634936,
      });

      assertEquals(outcome, {
        kind: "conflict",
        message: "User timer already created",
      });
    } finally {
      await stop();
    }
  });

  // Признак конфликта один на оба пути: тело без `id` считается
  // конфликтом, только когда несёт СТРОКОВЫЙ `message`. На 400 обе
  // половины признака закрыты ниже, здесь — те же две на 2xx.
  const NOT_CONFLICT_2XX: readonly {
    readonly title: string;
    readonly body: Record<string, unknown>;
  }[] = [
    { title: "без message", body: { detail: "ни таймер, ни конфликт" } },
    { title: "с нестроковым message", body: { message: 42 } },
  ];

  for (const { title, body } of NOT_CONFLICT_2XX) {
    await t.step(`2xx ${title} — разбор формы, а не конфликт`, async () => {
      const { baseUrl, stop } = startFakeKaiten(() =>
        Response.json(body, { status: 200 })
      );
      try {
        await assertRejects(
          () => startUserTimer(accessTo(baseUrl), { cardId: 65634936 }),
          KaitenError,
          "kaiten POST /user-timers: ответ не таймер",
        );
      } finally {
        await stop();
      }
    });
  }

  await t.step("конфликт: статус 400 и тело без id", async () => {
    const { baseUrl, stop } = startFakeKaiten(() =>
      Response.json({ message: "User timer already created" }, { status: 400 })
    );
    try {
      const outcome = await startUserTimer(accessTo(baseUrl), {
        cardId: 65634936,
      });

      assertEquals(outcome, {
        kind: "conflict",
        message: "User timer already created",
      });
    } finally {
      await stop();
    }
  });

  // Признак конфликта в отказе — конъюнкция трёх условий; каждый случай
  // ниже ломает ровно одно, и отказ обязан уйти вызывающему как есть.
  const NOT_CONFLICT: readonly {
    readonly title: string;
    readonly response: () => Response;
  }[] = [
    {
      title: "та же форма тела, но не 400",
      response: () =>
        Response.json({ message: "User timer already created" }, {
          status: 503,
        }),
    },
    {
      title: "400 с id в теле",
      response: () =>
        Response.json({ id: 555, message: "что-то не так" }, { status: 400 }),
    },
    {
      title: "400 с телом не JSON",
      response: () =>
        new Response("User timer already created", { status: 400 }),
    },
    {
      title: "400 без message",
      response: () => Response.json({ error: "bad request" }, { status: 400 }),
    },
    {
      title: "400 с нестроковым message",
      response: () => Response.json({ message: 42 }, { status: 400 }),
    },
  ];

  for (const testCase of NOT_CONFLICT) {
    await t.step(`${testCase.title} — отказ, а не конфликт`, async () => {
      const { baseUrl, stop } = startFakeKaiten(testCase.response);
      try {
        await assertRejects(
          () => startUserTimer(accessTo(baseUrl), { cardId: 65634936 }),
          KaitenError,
        );
      } finally {
        await stop();
      }
    });
  }
});

Deno.test("вызов 7: остановка таймера", async (t) => {
  const stopped = {
    ...RUNNING_TIMER,
    finished_at: "2026-07-20T10:00:31.000+03:00",
    card_time_log_id: 9002,
  };

  await t.step("метки времени, роль и комментарий в теле", async () => {
    const { baseUrl, seen, stop } = startFakeKaiten(() =>
      Response.json(stopped)
    );
    try {
      const timer = await stopUserTimer(accessTo(baseUrl), 555, {
        startedAt: "2026-07-20T10:00:00.000+03:00",
        finishedAt: "2026-07-20T10:00:31.000+03:00",
        comment: "работа над отчётом",
        roleId: 3,
      });

      assertEquals(seen[0].method, "PATCH");
      assertEquals(seen[0].pathname, "/api/latest/user-timers/555");
      // Разница меток — 31 секунда, не кратная минуте: длительность
      // записи считает и округляет вверх сервер, поэтому `time_spent` в
      // теле нет вовсе.
      assertEquals(JSON.parse(seen[0].body), {
        finished_at: "2026-07-20T10:00:31.000+03:00",
        started_at: "2026-07-20T10:00:00.000+03:00",
        comment: "работа над отчётом",
        role_id: 3,
      });
      assertEquals(timer, {
        id: 555,
        cardId: 65634936,
        cardTitle: "Отчёт за июль",
        comment: "работа над отчётом",
        startedAt: "2026-07-20T10:00:00.000+03:00",
        finishedAt: "2026-07-20T10:00:31.000+03:00",
        cardTimeLogId: 9002,
      });
    } finally {
      await stop();
    }
  });

  await t.step("без необязательных полей — только метка конца", async () => {
    const { baseUrl, seen, stop } = startFakeKaiten(() =>
      Response.json(stopped)
    );
    try {
      await stopUserTimer(accessTo(baseUrl), 555, {
        finishedAt: "2026-07-20T10:00:31.000+03:00",
      });

      assertEquals(JSON.parse(seen[0].body), {
        finished_at: "2026-07-20T10:00:31.000+03:00",
      });
    } finally {
      await stop();
    }
  });

  await t.step("ответ не таймер — ошибка запроса", async () => {
    const { baseUrl, stop } = startFakeKaiten(() =>
      Response.json({ message: "no timer" })
    );
    try {
      await assertRejects(
        () =>
          stopUserTimer(accessTo(baseUrl), 555, {
            finishedAt: "2026-07-20T10:00:31.000+03:00",
          }),
        KaitenError,
        "kaiten PATCH /user-timers/555: ответ не таймер",
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("вызов 8: сброс таймера без записи времени", async () => {
  const { baseUrl, seen, stop } = startFakeKaiten(() =>
    new Response(null, { status: 204 })
  );
  try {
    await resetUserTimer(accessTo(baseUrl), 555);

    assertEquals(seen[0].method, "DELETE");
    assertEquals(seen[0].pathname, "/api/latest/user-timers/555");
    assertEquals(seen[0].body, "");
  } finally {
    await stop();
  }
});

Deno.test("вызов 9: справочник ролей", async () => {
  const { baseUrl, seen, stop } = startFakeKaiten(() =>
    Response.json([
      { id: 3, name: "Разработка" },
      { id: 4, name: "Аналитика" },
      // Не роль: без числового id — пропускается, а не ломает список.
      "мусор",
    ])
  );
  try {
    const roles = await listUserRoles(accessTo(baseUrl));

    assertEquals(seen[0].method, "GET");
    assertEquals(seen[0].pathname, "/api/latest/user-roles");
    assertEquals(roles, [
      { id: 3, name: "Разработка" },
      { id: 4, name: "Аналитика" },
    ]);
  } finally {
    await stop();
  }
});

Deno.test("ответ на создание записи не той формы — ошибка запроса", async () => {
  const { baseUrl, stop } = startFakeKaiten(() =>
    Response.json({ message: "nope" }, { status: 201 })
  );
  try {
    await assertRejects(
      () =>
        createCardTimeLog(accessTo(baseUrl), 65634936, {
          forDate: "2026-07-20",
          timeSpent: 90,
          roleId: 3,
          comment: "",
        }),
      KaitenError,
      "kaiten POST /cards/65634936/time-logs: ответ не запись времени",
    );
  } finally {
    await stop();
  }
});
