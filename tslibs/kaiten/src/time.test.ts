/**
 * Каталог учёта времени (`platform/kaiten-api-time.md`): по
 * паре «запрос → ответ» на каждый из девяти вызовов. Форму отправленного
 * запроса и разбор ответа держат именно эти тесты: потребители библиотеки
 * проверяют своё поверх них.
 *
 * Фикстуры синтетические и объявлены здесь же: канал спецификаций
 * golden-файлов для этого каталога не несёт, а в `testdata/` лежат
 * только копии канала (`CLAUDE.md` пакета, «Раскладка»).
 *
 * Сервер — общий стенд модуля (`./testing.ts`).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeKaiten, startFakeKaiten } from "./testing.ts";
import { type KaitenAccess, KaitenError } from "../index.ts";
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

it("вызов 1: записи времени карточки", async () => {
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
  const { baseUrl, seen, stop } = await startFakeKaiten(() =>
    Response.json([TIME_LOG, minimal, "мусор", { card_id: 65634936 }]),
  );
  try {
    const logs = await listCardTimeLogs(accessTo(baseUrl), 65634936);

    expect(seen[0].method).toBe("GET");
    expect(seen[0].pathname).toBe("/api/latest/cards/65634936/time-logs");
    expect(seen[0].search).toBe("");
    expect(seen[0].body).toBe("");
    expect(logs).toStrictEqual([
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

describe("вызов 1: имя пользователя — только из объекта user", () => {
  // Один стенд на все случаи: они идут последовательно, поэтому ответ
  // выбирается по номеру уже принятого запроса.
  let stand: FakeKaiten;
  beforeAll(async () => {
    stand = await startFakeKaiten((seen) =>
      Response.json([
        {
          id: 9001,
          card_id: 65634936,
          time_spent: 90,
          for_date: "2026-07-20",
          comment: "",
          ...USER_NAME_CASES[seen.length - 1].nested,
        },
      ]),
    );
  });
  afterAll(() => stand.stop());
  for (const testCase of USER_NAME_CASES) {
    it(testCase.title, async () => {
      const logs = await listCardTimeLogs(accessTo(stand.baseUrl), 65634936);
      expect(logs[0].userName).toStrictEqual(testCase.userName);
    });
  }
});

it("вызов 2: создание записи — все четыре поля тела", async () => {
  const { baseUrl, seen, stop } = await startFakeKaiten(() =>
    // На POST сервер отдаёт `for_date` полной ISO-меткой, а не датой;
    // значим только календарный день.
    Response.json(
      { ...TIME_LOG, for_date: "2026-07-20T00:00:00.000Z" },
      {
        status: 201,
      },
    ),
  );
  try {
    const log = await createCardTimeLog(accessTo(baseUrl), 65634936, {
      forDate: "2026-07-20",
      timeSpent: 90,
      roleId: 3,
      comment: "правка отчёта",
    });

    expect(seen[0].method).toBe("POST");
    expect(seen[0].pathname).toBe("/api/latest/cards/65634936/time-logs");
    expect(JSON.parse(seen[0].body)).toStrictEqual({
      for_date: "2026-07-20",
      time_spent: 90,
      role_id: 3,
      comment: "правка отчёта",
    });
    expect(log).toStrictEqual(PARSED_TIME_LOG);
  } finally {
    await stop();
  }
});

describe("вызов 3: обновление — только заданные поля", () => {
  it("подмножество полей", async () => {
    const { baseUrl, seen, stop } = await startFakeKaiten(() =>
      Response.json({ ...TIME_LOG, time_spent: 120 }),
    );
    try {
      const log = await updateCardTimeLog(accessTo(baseUrl), 65634936, 9001, {
        timeSpent: 120,
      });

      expect(seen[0].method).toBe("PATCH");
      expect(seen[0].pathname).toBe(
        "/api/latest/cards/65634936/time-logs/9001",
      );
      // Ровно одно поле: остальные сервер не трогает.
      expect(JSON.parse(seen[0].body)).toStrictEqual({ time_spent: 120 });
      expect(log).toStrictEqual({ ...PARSED_TIME_LOG, timeSpent: 120 });
    } finally {
      await stop();
    }
  });

  it("все четыре поля разом", async () => {
    const { baseUrl, seen, stop } = await startFakeKaiten(() =>
      Response.json(TIME_LOG),
    );
    try {
      await updateCardTimeLog(accessTo(baseUrl), 65634936, 9001, {
        forDate: "2026-07-21",
        timeSpent: 60,
        roleId: 4,
        comment: "перенос дня",
      });

      expect(JSON.parse(seen[0].body)).toStrictEqual({
        for_date: "2026-07-21",
        time_spent: 60,
        role_id: 4,
        comment: "перенос дня",
      });
    } finally {
      await stop();
    }
  });

  it("ответ не той формы — ошибка запроса", async () => {
    const { baseUrl, stop } = await startFakeKaiten(() =>
      Response.json({ message: "nope" }),
    );
    try {
      const failure = updateCardTimeLog(accessTo(baseUrl), 65634936, 9001, {
        timeSpent: 120,
      });
      await expect(failure).rejects.toThrow(KaitenError);
      await expect(failure).rejects.toThrow(
        "kaiten PATCH /cards/65634936/time-logs/9001: ответ не запись времени",
      );
    } finally {
      await stop();
    }
  });

  it("пустая строка комментария очищает комментарий", async () => {
    const { baseUrl, seen, stop } = await startFakeKaiten(() =>
      // Сервер нормализует пустую строку в `null`, а читателю снова
      // отдаёт `""`.
      Response.json({ ...TIME_LOG, comment: "" }),
    );
    try {
      const log = await updateCardTimeLog(accessTo(baseUrl), 65634936, 9001, {
        comment: "",
      });

      expect(JSON.parse(seen[0].body)).toStrictEqual({ comment: "" });
      expect(log.comment).toBe("");
    } finally {
      await stop();
    }
  });
});

it("вызов 4: удаление записи — успех с пустым телом", async () => {
  const { baseUrl, seen, stop } = await startFakeKaiten(
    () => new Response(null, { status: 204 }),
  );
  try {
    await deleteCardTimeLog(accessTo(baseUrl), 65634936, 9001);

    expect(seen[0].method).toBe("DELETE");
    expect(seen[0].pathname).toBe("/api/latest/cards/65634936/time-logs/9001");
    expect(seen[0].body).toBe("");
  } finally {
    await stop();
  }
});

describe("вызов 5: записи пользователя за окно", () => {
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

  it("обе границы окна уходят всегда", async () => {
    const { baseUrl, seen, stop } = await startFakeKaiten(() =>
      Response.json([{ ...TIME_LOG, card }]),
    );
    try {
      const logs = await listUserTimeLogs(accessTo(baseUrl), 77, {
        from: "2026-07-01",
        to: "2026-07-31",
      });

      expect(seen[0].method).toBe("GET");
      expect(seen[0].pathname).toBe("/api/latest/users/77/time-logs");
      // Без обеих границ сервер отвечает 500, а не «за всё время».
      expect(seen[0].search).toBe("?from=2026-07-01&to=2026-07-31");
      expect(logs).toStrictEqual([{ ...PARSED_TIME_LOG, card: parsedCard }]);
    } finally {
      await stop();
    }
  });

  it("карточки нет — card: null", async () => {
    const { baseUrl, stop } = await startFakeKaiten(() =>
      Response.json([{ ...TIME_LOG, card: null }]),
    );
    try {
      const logs = await listUserTimeLogs(accessTo(baseUrl), 77, {
        from: "2026-07-01",
        to: "2026-07-31",
      });

      expect(logs).toStrictEqual([{ ...PARSED_TIME_LOG, card: null }]);
    } finally {
      await stop();
    }
  });
});

describe("вызов 6: запуск таймера", () => {
  it("успех: тело с id — таймер запущен", async () => {
    const { baseUrl, seen, stop } = await startFakeKaiten(() =>
      Response.json(RUNNING_TIMER),
    );
    try {
      const outcome = await startUserTimer(accessTo(baseUrl), {
        cardId: 65634936,
        comment: "работа над отчётом",
      });

      expect(seen[0].method).toBe("POST");
      expect(seen[0].pathname).toBe("/api/latest/user-timers");
      // Роли в теле нет: сервер её не сохраняет, тип работы выбирается
      // только при остановке.
      expect(JSON.parse(seen[0].body)).toStrictEqual({
        card_id: 65634936,
        comment: "работа над отчётом",
      });
      expect(outcome).toStrictEqual({
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

  it("успех: форму решает только id, прочие поля пусты", async () => {
    const { baseUrl, stop } = await startFakeKaiten(() =>
      Response.json({ id: 555, card_id: null, started_at: null }),
    );
    try {
      const outcome = await startUserTimer(accessTo(baseUrl), {
        cardId: 65634936,
      });

      expect(outcome).toStrictEqual({
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

  it("без комментария ключа comment в теле нет", async () => {
    const { baseUrl, seen, stop } = await startFakeKaiten(() =>
      Response.json(RUNNING_TIMER),
    );
    try {
      await startUserTimer(accessTo(baseUrl), { cardId: 65634936 });

      expect(JSON.parse(seen[0].body)).toStrictEqual({ card_id: 65634936 });
    } finally {
      await stop();
    }
  });

  it("конфликт: тело без id при статусе 2xx", async () => {
    const { baseUrl, stop } = await startFakeKaiten(() =>
      // Статус успеха: формы различаются составом тела, а не кодом.
      Response.json({ message: "User timer already created" }, { status: 200 }),
    );
    try {
      const outcome = await startUserTimer(accessTo(baseUrl), {
        cardId: 65634936,
      });

      expect(outcome).toStrictEqual({
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
    it(`2xx ${title} — разбор формы, а не конфликт`, async () => {
      const { baseUrl, stop } = await startFakeKaiten(() =>
        Response.json(body, { status: 200 }),
      );
      try {
        const failure = startUserTimer(accessTo(baseUrl), { cardId: 65634936 });
        await expect(failure).rejects.toThrow(KaitenError);
        await expect(failure).rejects.toThrow(
          "kaiten POST /user-timers: ответ не таймер",
        );
      } finally {
        await stop();
      }
    });
  }

  it("конфликт: статус 400 и тело без id", async () => {
    const { baseUrl, stop } = await startFakeKaiten(() =>
      Response.json({ message: "User timer already created" }, { status: 400 }),
    );
    try {
      const outcome = await startUserTimer(accessTo(baseUrl), {
        cardId: 65634936,
      });

      expect(outcome).toStrictEqual({
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
        Response.json(
          { message: "User timer already created" },
          {
            status: 503,
          },
        ),
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
    it(`${testCase.title} — отказ, а не конфликт`, async () => {
      const { baseUrl, stop } = await startFakeKaiten(testCase.response);
      try {
        await expect(
          startUserTimer(accessTo(baseUrl), { cardId: 65634936 }),
        ).rejects.toThrow(KaitenError);
      } finally {
        await stop();
      }
    });
  }
});

describe("вызов 7: остановка таймера", () => {
  const stopped = {
    ...RUNNING_TIMER,
    finished_at: "2026-07-20T10:00:31.000+03:00",
    card_time_log_id: 9002,
  };

  it("метки времени, роль и комментарий в теле", async () => {
    const { baseUrl, seen, stop } = await startFakeKaiten(() =>
      Response.json(stopped),
    );
    try {
      const timer = await stopUserTimer(accessTo(baseUrl), 555, {
        startedAt: "2026-07-20T10:00:00.000+03:00",
        finishedAt: "2026-07-20T10:00:31.000+03:00",
        comment: "работа над отчётом",
        roleId: 3,
      });

      expect(seen[0].method).toBe("PATCH");
      expect(seen[0].pathname).toBe("/api/latest/user-timers/555");
      // Разница меток — 31 секунда, не кратная минуте: длительность
      // записи считает и округляет вверх сервер, поэтому `time_spent` в
      // теле нет вовсе.
      expect(JSON.parse(seen[0].body)).toStrictEqual({
        finished_at: "2026-07-20T10:00:31.000+03:00",
        started_at: "2026-07-20T10:00:00.000+03:00",
        comment: "работа над отчётом",
        role_id: 3,
      });
      expect(timer).toStrictEqual({
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

  it("без необязательных полей — только метка конца", async () => {
    const { baseUrl, seen, stop } = await startFakeKaiten(() =>
      Response.json(stopped),
    );
    try {
      await stopUserTimer(accessTo(baseUrl), 555, {
        finishedAt: "2026-07-20T10:00:31.000+03:00",
      });

      expect(JSON.parse(seen[0].body)).toStrictEqual({
        finished_at: "2026-07-20T10:00:31.000+03:00",
      });
    } finally {
      await stop();
    }
  });

  it("ответ не таймер — ошибка запроса", async () => {
    const { baseUrl, stop } = await startFakeKaiten(() =>
      Response.json({ message: "no timer" }),
    );
    try {
      const failure = stopUserTimer(accessTo(baseUrl), 555, {
        finishedAt: "2026-07-20T10:00:31.000+03:00",
      });
      await expect(failure).rejects.toThrow(KaitenError);
      await expect(failure).rejects.toThrow(
        "kaiten PATCH /user-timers/555: ответ не таймер",
      );
    } finally {
      await stop();
    }
  });
});

it("вызов 8: сброс таймера без записи времени", async () => {
  const { baseUrl, seen, stop } = await startFakeKaiten(
    () => new Response(null, { status: 204 }),
  );
  try {
    await resetUserTimer(accessTo(baseUrl), 555);

    expect(seen[0].method).toBe("DELETE");
    expect(seen[0].pathname).toBe("/api/latest/user-timers/555");
    expect(seen[0].body).toBe("");
  } finally {
    await stop();
  }
});

it("вызов 9: справочник ролей", async () => {
  const { baseUrl, seen, stop } = await startFakeKaiten(() =>
    Response.json([
      { id: 3, name: "Разработка" },
      { id: 4, name: "Аналитика" },
      // Не роль: без числового id — пропускается, а не ломает список.
      "мусор",
    ]),
  );
  try {
    const roles = await listUserRoles(accessTo(baseUrl));

    expect(seen[0].method).toBe("GET");
    expect(seen[0].pathname).toBe("/api/latest/user-roles");
    expect(roles).toStrictEqual([
      { id: 3, name: "Разработка" },
      { id: 4, name: "Аналитика" },
    ]);
  } finally {
    await stop();
  }
});

it("ответ на создание записи не той формы — ошибка запроса", async () => {
  const { baseUrl, stop } = await startFakeKaiten(() =>
    Response.json({ message: "nope" }, { status: 201 }),
  );
  try {
    const failure = createCardTimeLog(accessTo(baseUrl), 65634936, {
      forDate: "2026-07-20",
      timeSpent: 90,
      roleId: 3,
      comment: "",
    });
    await expect(failure).rejects.toThrow(KaitenError);
    await expect(failure).rejects.toThrow(
      "kaiten POST /cards/65634936/time-logs: ответ не запись времени",
    );
  } finally {
    await stop();
  }
});
