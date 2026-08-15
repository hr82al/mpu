/**
 * Записи учёта времени — `mpu kiten time ls | add | edit | rm`
 * (`docs/specs/kiten-time.md`). Успешные ветви закрыты голденами канала,
 * снятыми живым прогоном; вызов идёт от argv, как из точки входа, а
 * каталог ходит в фейковый Kaiten на петле (`../kaiten/testing.ts`) — так
 * под проверку попадает и состав запросов, который у этой команды сам по
 * себе контракт: клиентский фильтр «только мои» стоит одного лишнего
 * вызова, а справочник ролей мутирующие подкоманды читают всегда — ради
 * названия роли в строке успеха, которого ответ мутации не несёт.
 *
 * Таблица `ls` сверяется по составу колонок, порядку строк и итогу:
 * ширина колонок и переносы длинных значений контрактом не являются
 * (`kiten-time.md`, «Golden-примеры»).
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  type Command,
  type CommandIo,
  DomainError,
  formatCommandError,
  UsageError,
} from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { type CapturedRequest, startFakeKaiten } from "../kaiten/testing.ts";
import {
  kitenTimeAddCommand,
  kitenTimeEditCommand,
  kitenTimeLsCommand,
  kitenTimeRmCommand,
} from "./mod.ts";

const API_KEY = "proba-kaiten-key-Q3z8Nw";
const CARD_ID = 10000001;
const SELECTOR = String(CARD_ID);
const OWNER_ID = 900001;

const LOGS_PATH = `/api/latest/cards/${CARD_ID}/time-logs`;
const CURRENT_USER_PATH = "/api/latest/users/current";
const ROLES_PATH = "/api/latest/user-roles";
const logPath = (logId: number) => `${LOGS_PATH}/${logId}`;

/** Адрес карточки в голденах: снят с обезличенного живого прогона. */
const GOLDEN_CARD_URL = `https://kaiten.example.test/${CARD_ID}`;

/** Env-файл стенда с настроенной ролью по умолчанию. */
const envWithRole: Readonly<Record<string, string>> = {
  KITEN_TIME_ROLE: "Тестирование",
};

const ROLES = [
  { id: 12058, name: "Техподдержка" },
  { id: 12132, name: "Тестирование" },
];

/** Живая запись в форме ответа внешней системы. */
function rawLog(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7000001,
    card_id: CARD_ID,
    user_id: OWNER_ID,
    author_id: OWNER_ID,
    role_id: 12058,
    role: { id: 12058, name: "Техподдержка" },
    user: { id: OWNER_ID, full_name: "Иван Тестов" },
    time_spent: 75,
    for_date: "2026-08-14",
    comment: "разбор жалобы",
    ...patch,
  };
}

/**
 * Ответ создания и правки записи — форма живой системы, а не формы
 * списка. Вложенного объекта роли в нём нет вовсе, а `for_date` приходит
 * полной ISO-меткой (`platform/kaiten-api-time.md`, вызовы 2 и 3).
 * Фикстура богаче реального ответа делает голден проверкой самого себя:
 * название роли в строке успеха бралось бы из фейка, которого живая
 * система не отдаёт.
 */
function rawMutationLog(
  patch: Record<string, unknown> = {},
): Record<string, unknown> {
  const { role: _role, for_date, ...rest } = rawLog(patch);
  return { ...rest, for_date: `${String(for_date)}T00:00:00.000Z` };
}

/** Три записи карточки из голденов `ls`. */
const CARD_LOGS = [
  rawLog(),
  rawLog({
    id: 7000002,
    role_id: 12132,
    role: { id: 12132, name: "Тестирование" },
    time_spent: 45,
    for_date: "2026-08-15",
    comment: "проверка на стенде",
  }),
  rawLog({
    id: 7000003,
    time_spent: 120,
    for_date: "2026-08-15",
    comment: "",
  }),
];

function golden(name: string): Promise<string> {
  return Deno.readTextFile(
    new URL(`testdata/kiten-time/${name}`, import.meta.url),
  );
}

/** Голден с адресом карточки под стенд: базовый URL у него свой. */
async function expected(name: string, baseUrl: string): Promise<string> {
  return (await golden(name)).replaceAll(
    GOLDEN_CARD_URL,
    `${baseUrl}/${CARD_ID}`,
  );
}

/** Чем отвечать на «МЕТОД путь»; пара вне таблицы — красный тест. */
type Routes = Readonly<Record<string, () => Response | Promise<Response>>>;

interface Stand {
  readonly io: CommandIo;
  readonly baseUrl: string;
  readonly seen: readonly CapturedRequest[];
  readonly stop: () => Promise<void>;
}

function stand(
  routes: Routes,
  overrides: Partial<CommandIo> = {},
  extraEnv: Readonly<Record<string, string>> = {},
): Stand {
  const fake = startFakeKaiten((seen) => {
    const last = seen[seen.length - 1];
    const route = routes[`${last.method} ${last.pathname}`];
    return route === undefined
      ? new Response("вызов, которого тест не ждал", { status: 500 })
      : route();
  });
  const values: Readonly<Record<string, string>> = {
    KITEN_API_KEY: API_KEY,
    KITEN_BASE_URL: fake.baseUrl,
    ...extraEnv,
  };
  const io = makeFakeIo({
    envFile: {
      get: (name) => values[name],
      values: () => values,
      require: (name) => values[name] ?? "",
      set: () => Promise.resolve(),
    },
    ...overrides,
  });
  return { io, baseUrl: fake.baseUrl, seen: fake.seen, stop: fake.stop };
}

/** Стенд с тремя записями карточки и владельцем токена. */
function readStand(
  extra: Routes = {},
  overrides: Partial<CommandIo> = {},
  extraEnv: Readonly<Record<string, string>> = {},
) {
  return stand(
    {
      [`GET ${LOGS_PATH}`]: () => Response.json(CARD_LOGS),
      [`GET ${CURRENT_USER_PATH}`]: () =>
        Response.json({ id: OWNER_ID, full_name: "Иван Тестов" }),
      ...extra,
    },
    overrides,
    extraEnv,
  );
}

/** Текст вывода так, как его напечатает точка входа. */
async function output(
  command: Command,
  argv: readonly string[],
  io: CommandIo,
): Promise<string> {
  return command.renderResult(await command.invoke(argv, io), argv);
}

/** Вызовы в порядке обращения: «МЕТОД путь». */
function calls(seen: readonly CapturedRequest[]): readonly string[] {
  return seen.map((request) => `${request.method} ${request.pathname}`);
}

/** Заголовок таблицы ячейками: колонки разделены двумя и более пробелами. */
function headerCells(table: string): readonly string[] {
  return table.split("\n")[0].trim().split(/\s{2,}/);
}

/** Колонка ID в порядке печати; строки-продолжения переноса пропускаются. */
function idColumn(table: string): readonly string[] {
  return table
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((cell) => /^\d+$/.test(cell));
}

/** Итоговая строка таблицы. */
function totalLine(table: string): string {
  const lines = table.trimEnd().split("\n");
  return lines[lines.length - 1];
}

/** Текст ошибки так, как его напечатает точка входа, с переводом строки. */
async function errorText(
  command: Command,
  argv: readonly string[],
  io: CommandIo,
  kind: typeof UsageError | typeof DomainError,
): Promise<string> {
  const err = await assertRejects(() => command.invoke(argv, io), kind);
  return `${formatCommandError(command.errorName, err)}\n`;
}

Deno.test("time ls: таблица, фильтры и состав вызовов", async (t) => {
  await t.step("без --all — фильтр по владельцу токена", async () => {
    const { io, baseUrl, seen, stop } = readStand();
    try {
      const table = await output(kitenTimeLsCommand, [SELECTOR], io);
      const want = await expected("ls-stdout.txt", baseUrl);
      assertEquals(headerCells(table), headerCells(want));
      assertEquals(idColumn(table), idColumn(want));
      assertEquals(totalLine(table), totalLine(want));
      // Клиентский фильтр стоит второго вызова — за владельцем токена.
      assertEquals(calls(seen), [
        `GET ${LOGS_PATH}`,
        `GET ${CURRENT_USER_PATH}`,
      ]);
    } finally {
      await stop();
    }
  });

  await t.step("--all: колонка пользователя и один вызов", async () => {
    const { io, baseUrl, seen, stop } = readStand();
    try {
      const table = await output(kitenTimeLsCommand, [SELECTOR, "--all"], io);
      const want = await expected("ls-all-stdout.txt", baseUrl);
      assertEquals(headerCells(table), headerCells(want));
      assertEquals(idColumn(table), idColumn(want));
      assertEquals(totalLine(table), totalLine(want));
      assertEquals(calls(seen), [`GET ${LOGS_PATH}`]);
    } finally {
      await stop();
    }
  });

  await t.step("--json: голден побайтово", async () => {
    const { io, stop } = readStand();
    try {
      assertEquals(
        await output(kitenTimeLsCommand, [SELECTOR, "--json"], io),
        await golden("ls-json-stdout.txt"),
      );
    } finally {
      await stop();
    }
  });

  await t.step("чужие записи отфильтрованы без --all", async () => {
    const { io, stop } = stand({
      [`GET ${LOGS_PATH}`]: () =>
        Response.json([
          rawLog({ id: 7000009, user_id: 900002, user: { full_name: "Пётр" } }),
        ]),
      [`GET ${CURRENT_USER_PATH}`]: () => Response.json({ id: OWNER_ID }),
    });
    try {
      assertEquals(
        await output(kitenTimeLsCommand, [SELECTOR], io),
        await golden("ls-empty-stdout.txt"),
      );
    } finally {
      await stop();
    }
  });

  await t.step("границы дат включительны", async () => {
    const { io, stop } = readStand();
    try {
      const text = await output(
        kitenTimeLsCommand,
        [SELECTOR, "--date-from", "2026-08-15", "--date-to", "2026-08-15"],
        io,
      );
      assertEquals(idColumn(text), ["7000002", "7000003"]);
      assertEquals(totalLine(text), "итого: 2 ч 45 мин (2 записи)");
    } finally {
      await stop();
    }
  });

  await t.step("--role фильтрует и не подставляет умолчание", async () => {
    const { io, seen, stop } = readStand({
      [`GET ${ROLES_PATH}`]: () => Response.json(ROLES),
    });
    try {
      const text = await output(
        kitenTimeLsCommand,
        [SELECTOR, "--role", "Тестирование"],
        io,
      );
      assertEquals(idColumn(text), ["7000002"]);
      assertEquals(calls(seen), [
        `GET ${ROLES_PATH}`,
        `GET ${LOGS_PATH}`,
        `GET ${CURRENT_USER_PATH}`,
      ]);
    } finally {
      await stop();
    }
  });

  await t.step("без --role записи всех ролей остаются", async () => {
    const { io, seen, stop } = readStand();
    try {
      const text = await output(kitenTimeLsCommand, [SELECTOR], io);
      assertEquals(idColumn(text).length, 3);
      assertEquals(calls(seen).includes(`GET ${ROLES_PATH}`), false);
    } finally {
      await stop();
    }
  });

  await t.step(
    "роль без названия: таблица печатает id, JSON — null",
    async () => {
      const noName = [rawLog({ role: null })];
      const { io, stop } = stand({
        [`GET ${LOGS_PATH}`]: () => Response.json(noName),
        [`GET ${CURRENT_USER_PATH}`]: () => Response.json({ id: OWNER_ID }),
      });
      try {
        const table = await output(kitenTimeLsCommand, [SELECTOR], io);
        assertEquals(table.split("\n")[1].includes("12058"), true);
      } finally {
        await stop();
      }
      const second = stand({
        [`GET ${LOGS_PATH}`]: () => Response.json(noName),
        [`GET ${CURRENT_USER_PATH}`]: () => Response.json({ id: OWNER_ID }),
      });
      try {
        const json = await output(
          kitenTimeLsCommand,
          [SELECTOR, "--json"],
          second.io,
        );
        assertEquals(JSON.parse(json).logs[0].role, null);
        assertEquals(JSON.parse(json).logs[0].role_id, 12058);
      } finally {
        await second.stop();
      }
    },
  );

  await t.step("нераспарсенная дата — ошибка ввода до сети", async () => {
    const { io, seen, stop } = readStand();
    try {
      assertEquals(
        await errorText(
          kitenTimeLsCommand,
          [SELECTOR, "--date-from", "15.08.2026"],
          io,
          UsageError,
        ),
        `mpu kiten time ls: --date-from='15.08.2026': ожидается YYYY-MM-DD\n`,
      );
      assertEquals(calls(seen), []);
    } finally {
      await stop();
    }
  });
});

Deno.test("time add: создание записи", async (t) => {
  await t.step("голден строки успеха и тело запроса", async () => {
    const { io, baseUrl, seen, stop } = stand({
      [`GET ${ROLES_PATH}`]: () => Response.json(ROLES),
      [`POST ${LOGS_PATH}`]: () => Response.json(rawMutationLog()),
    });
    try {
      assertEquals(
        await output(
          kitenTimeAddCommand,
          [SELECTOR, "1h15m", "--date", "2026-08-14", "-m", "разбор жалобы"],
          io,
        ),
        await expected("add-stdout.txt", baseUrl),
      );
      // Справочник ролей — не резолв, а источник названия для строки
      // успеха: ответ создания записи названия роли не несёт.
      assertEquals(calls(seen), [`GET ${ROLES_PATH}`, `POST ${LOGS_PATH}`]);
      assertEquals(JSON.parse(seen[1].body), {
        for_date: "2026-08-14",
        time_spent: 75,
        role_id: 12058,
        comment: "разбор жалобы",
      });
    } finally {
      await stop();
    }
  });

  await t.step("без --comment уходит пустая строка", async () => {
    const { io, seen, stop } = stand({
      [`GET ${ROLES_PATH}`]: () => Response.json(ROLES),
      [`POST ${LOGS_PATH}`]: () =>
        Response.json(rawMutationLog({ comment: "" })),
    });
    try {
      await output(kitenTimeAddCommand, [
        SELECTOR,
        "45",
        "--date",
        "2026-08-14",
      ], io);
      assertEquals(JSON.parse(seen[1].body).comment, "");
    } finally {
      await stop();
    }
  });

  await t.step("нечисловая роль резолвится одним запросом", async () => {
    const { io, seen, stop } = stand({
      [`GET ${ROLES_PATH}`]: () => Response.json(ROLES),
      [`POST ${LOGS_PATH}`]: () => Response.json(rawMutationLog()),
    });
    try {
      await output(
        kitenTimeAddCommand,
        [SELECTOR, "45", "--date", "2026-08-14", "--role", "Тестирование"],
        io,
      );
      // Справочник читается один раз: он же резолвит `--role`, он же
      // даёт название для строки успеха.
      assertEquals(calls(seen), [`GET ${ROLES_PATH}`, `POST ${LOGS_PATH}`]);
      assertEquals(JSON.parse(seen[1].body).role_id, 12132);
    } finally {
      await stop();
    }
  });

  await t.step("дата в будущем: предупреждение и запись", async () => {
    const notes: string[] = [];
    const future = futureDate();
    const { io, seen, stop } = stand(
      {
        [`GET ${ROLES_PATH}`]: () => Response.json(ROLES),
        [`POST ${LOGS_PATH}`]: () => Response.json(rawMutationLog()),
      },
      { progress: (line) => void notes.push(line) },
    );
    try {
      await output(kitenTimeAddCommand, [SELECTOR, "45", "--date", future], io);
      assertEquals(notes, [`внимание: дата ${future} в будущем`]);
      assertEquals(calls(seen), [`GET ${ROLES_PATH}`, `POST ${LOGS_PATH}`]);
    } finally {
      await stop();
    }
  });

  await t.step("длительность разбирается до сети", async () => {
    const { io, seen, stop } = stand({});
    try {
      assertEquals(
        await errorText(kitenTimeAddCommand, [SELECTOR, "0"], io, UsageError),
        `mpu kiten time add: ${await golden("err-duration-zero-message.txt")}`,
      );
      assertEquals(calls(seen), []);
    } finally {
      await stop();
    }
  });
});

Deno.test("time edit: частичное обновление", async (t) => {
  await t.step("две оси разом — голден и тело запроса", async () => {
    const { io, baseUrl, seen, stop } = readStand({
      [`PATCH ${logPath(7000001)}`]: () =>
        Response.json(
          rawMutationLog({ time_spent: 120, comment: "разбор жалобы и фикс" }),
        ),
    });
    try {
      assertEquals(
        await output(
          kitenTimeEditCommand,
          [SELECTOR, "7000001", "--time", "2h", "-m", "разбор жалобы и фикс"],
          io,
        ),
        await expected("edit-stdout.txt", baseUrl),
      );
      assertEquals(calls(seen), [
        `GET ${LOGS_PATH}`,
        `GET ${CURRENT_USER_PATH}`,
        `PATCH ${logPath(7000001)}`,
      ]);
      // Тело только из названных осей: даты и роли в нём нет.
      assertEquals(JSON.parse(seen[2].body), {
        time_spent: 120,
        comment: "разбор жалобы и фикс",
      });
    } finally {
      await stop();
    }
  });

  await t.step("--comment '' очищает комментарий", async () => {
    const { io, baseUrl, seen, stop } = readStand({
      [`PATCH ${logPath(7000002)}`]: () =>
        Response.json(
          rawMutationLog({
            id: 7000002,
            role_id: 12132,
            time_spent: 45,
            for_date: "2026-08-15",
            comment: "",
          }),
        ),
    });
    try {
      assertEquals(
        await output(kitenTimeEditCommand, [SELECTOR, "7000002", "-m", ""], io),
        await expected("edit-comment-cleared-stdout.txt", baseUrl),
      );
      assertEquals(JSON.parse(seen[2].body), { comment: "" });
    } finally {
      await stop();
    }
  });

  await t.step("ось роли печатает название, а не id", async () => {
    // Возврат приёмки: ответ правки записи названия роли не несёт —
    // только `role_id`. Без справочника ось печаталась бы числом.
    const { io, seen, stop } = readStand({
      [`GET ${ROLES_PATH}`]: () => Response.json(ROLES),
      [`PATCH ${logPath(7000001)}`]: () =>
        Response.json(rawMutationLog({ role_id: 12132 })),
    });
    try {
      const text = await output(
        kitenTimeEditCommand,
        [SELECTOR, "7000001", "--role", "Тестирование"],
        io,
      );
      assertEquals(text.includes("· роль Тестирование ·"), true);
      assertEquals(calls(seen).includes(`GET ${ROLES_PATH}`), true);
    } finally {
      await stop();
    }
  });

  await t.step("настроенная роль не становится осью сама", async () => {
    const { io, seen, stop } = readStand(
      {
        [`PATCH ${logPath(7000001)}`]: () =>
          Response.json(rawMutationLog({ time_spent: 120 })),
      },
      {},
      envWithRole,
    );
    try {
      await output(
        kitenTimeEditCommand,
        [SELECTOR, "7000001", "--time", "2h"],
        io,
      );
      // Настройка роли действует только там, где роль выбирается: в
      // `edit` без --role оси роли нет, и справочник не запрашивается.
      assertEquals(JSON.parse(seen[2].body), { time_spent: 120 });
      assertEquals(calls(seen).includes(`GET ${ROLES_PATH}`), false);
    } finally {
      await stop();
    }
  });

  await t.step("без единой оси — ошибка ввода до сети", async () => {
    const { io, seen, stop } = readStand();
    try {
      assertEquals(
        await errorText(
          kitenTimeEditCommand,
          [SELECTOR, "7000001"],
          io,
          UsageError,
        ),
        `mpu kiten time edit: ${await golden("err-edit-no-axis-message.txt")}`,
      );
      assertEquals(calls(seen), []);
    } finally {
      await stop();
    }
  });

  await t.step("--time называет флаг, а не DURATION", async () => {
    const { io, stop } = readStand();
    try {
      assertEquals(
        await errorText(
          kitenTimeEditCommand,
          [SELECTOR, "7000001", "--time", "0"],
          io,
          UsageError,
        ),
        `mpu kiten time edit: ${await golden(
          "err-edit-duration-zero-message.txt",
        )}`,
      );
    } finally {
      await stop();
    }
  });

  await t.step("чужая запись без --force не меняется", async () => {
    const { io, seen, stop } = stand({
      [`GET ${LOGS_PATH}`]: () => Response.json([rawLog({ user_id: 900002 })]),
      [`GET ${CURRENT_USER_PATH}`]: () => Response.json({ id: OWNER_ID }),
    });
    try {
      assertEquals(
        await errorText(
          kitenTimeEditCommand,
          [SELECTOR, "7000001", "--time", "2h"],
          io,
          DomainError,
        ),
        "mpu kiten time edit: запись 7000001 принадлежит другому " +
          `пользователю (user_id=900002, я ${OWNER_ID}); повтори с --force\n`,
      );
      assertEquals(calls(seen), [
        `GET ${LOGS_PATH}`,
        `GET ${CURRENT_USER_PATH}`,
      ]);
    } finally {
      await stop();
    }
  });

  await t.step("--force снимает и проверку, и её запрос", async () => {
    const { io, seen, stop } = stand({
      [`GET ${LOGS_PATH}`]: () => Response.json([rawLog({ user_id: 900002 })]),
      [`PATCH ${logPath(7000001)}`]: () =>
        Response.json(rawMutationLog({ user_id: 900002, time_spent: 120 })),
    });
    try {
      await output(
        kitenTimeEditCommand,
        [SELECTOR, "7000001", "--time", "2h", "--force"],
        io,
      );
      assertEquals(calls(seen), [
        `GET ${LOGS_PATH}`,
        `PATCH ${logPath(7000001)}`,
      ]);
    } finally {
      await stop();
    }
  });

  await t.step("запись без владельца меняется без --force", async () => {
    const { io, seen, stop } = stand({
      [`GET ${LOGS_PATH}`]: () => Response.json([rawLog({ user_id: null })]),
      [`PATCH ${logPath(7000001)}`]: () =>
        Response.json(rawMutationLog({ user_id: null, time_spent: 120 })),
    });
    try {
      await output(
        kitenTimeEditCommand,
        [SELECTOR, "7000001", "--time", "2h"],
        io,
      );
      assertEquals(calls(seen), [
        `GET ${LOGS_PATH}`,
        `PATCH ${logPath(7000001)}`,
      ]);
    } finally {
      await stop();
    }
  });
});

Deno.test("time rm: удаление записи", async (t) => {
  await t.step("голден удалённой записи без комментария", async () => {
    const { io, baseUrl, seen, stop } = readStand({
      [`DELETE ${logPath(7000003)}`]: () => new Response(null, { status: 204 }),
    });
    try {
      assertEquals(
        await output(kitenTimeRmCommand, [SELECTOR, "7000003"], io),
        await expected("rm-stdout.txt", baseUrl),
      );
      assertEquals(calls(seen), [
        `GET ${LOGS_PATH}`,
        `GET ${CURRENT_USER_PATH}`,
        `DELETE ${logPath(7000003)}`,
      ]);
    } finally {
      await stop();
    }
  });

  await t.step("голден удалённой записи с комментарием", async () => {
    const { io, baseUrl, stop } = stand({
      [`GET ${LOGS_PATH}`]: () =>
        Response.json([
          rawLog({ time_spent: 120, comment: "разбор жалобы и фикс" }),
        ]),
      [`GET ${CURRENT_USER_PATH}`]: () => Response.json({ id: OWNER_ID }),
      [`DELETE ${logPath(7000001)}`]: () => new Response(null, { status: 204 }),
    });
    try {
      assertEquals(
        await output(kitenTimeRmCommand, [SELECTOR, "7000001"], io),
        await expected("rm-with-comment-stdout.txt", baseUrl),
      );
    } finally {
      await stop();
    }
  });

  await t.step("записи нет на карточке — голден ошибки", async () => {
    const { io, seen, stop } = readStand();
    try {
      assertEquals(
        await errorText(
          kitenTimeRmCommand,
          [SELECTOR, "9999999"],
          io,
          DomainError,
        ),
        await golden("err-log-not-on-card-stderr.txt"),
      );
      // Удаления не было: чужого id команда не трогает.
      assertEquals(calls(seen), [`GET ${LOGS_PATH}`]);
    } finally {
      await stop();
    }
  });

  await t.step("чужая запись без --force не удаляется", async () => {
    const { io, seen, stop } = stand({
      [`GET ${LOGS_PATH}`]: () => Response.json([rawLog({ user_id: 900002 })]),
      [`GET ${CURRENT_USER_PATH}`]: () => Response.json({ id: OWNER_ID }),
    });
    try {
      assertEquals(
        await errorText(
          kitenTimeRmCommand,
          [SELECTOR, "7000001"],
          io,
          DomainError,
        ),
        "mpu kiten time rm: запись 7000001 принадлежит другому " +
          `пользователю (user_id=900002, я ${OWNER_ID}); повтори с --force\n`,
      );
      assertEquals(calls(seen).includes(`DELETE ${logPath(7000001)}`), false);
    } finally {
      await stop();
    }
  });

  await t.step("нецелой LOG_ID — ошибка ввода до сети", async () => {
    const { io, seen, stop } = readStand();
    try {
      assertEquals(
        await errorText(kitenTimeRmCommand, [SELECTOR, "abc"], io, UsageError),
        "mpu kiten time rm: LOG_ID 'abc': ожидается id записи — целое число\n",
      );
      assertEquals(calls(seen), []);
    } finally {
      await stop();
    }
  });
});

/** Заведомо будущий день по МСК: сегодня плюс неделя. */
function futureDate(): string {
  const week = 7 * 24 * 60 * 60 * 1000;
  return new Date(Date.now() + week + 3 * 60 * 60 * 1000).toISOString().slice(
    0,
    10,
  );
}
