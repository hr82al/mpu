/**
 * Справочные подкоманды `mpu kiten` (`docs/specs/kiten-refs.md`): формы
 * `--json` закрыты голденами канала, текстовые формы — составом колонок
 * и итоговой строкой (рамка контрактом не является).
 *
 * Вход тестов — ответы внешней границы: команда ходит в каталог, каталог
 * — в фейковый Kaiten на петле (`../kaiten/testing.ts`), кэш-БД
 * настоящая во временном каталоге. Так проверяется и то, чего команда НЕ
 * делает: `whoami` не открывает кэш вовсе (в фейке порта эта операция
 * падает), а фильтры `--all`/`--space` не доходят до записи кэша.
 *
 * Вызов идёт от argv, как из точки входа: разбор делает схема самой
 * команды.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type Command,
  type CommandIo,
  DomainError,
  formatCommandError,
  UsageError,
} from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { startFakeKaiten } from "../kaiten/testing.ts";
import {
  kitenBoardsCommand,
  kitenColumnsCommand,
  kitenLanesCommand,
  kitenRolesCommand,
  kitenSpacesCommand,
  kitenWhoamiCommand,
} from "./mod.ts";

const USER_PATH = "/api/latest/users/current";
const SPACES_PATH = "/api/latest/spaces";
const ROLES_PATH = "/api/latest/user-roles";
const lanesPath = (boardId: number) => `/api/latest/boards/${boardId}/lanes`;
const columnsPath = (boardId: number) =>
  `/api/latest/boards/${boardId}/columns`;

/** Владелец токена под голден `whoami.json`. */
const USER = {
  id: 1001,
  full_name: "Иван Иванов",
  username: "user001",
  email: "user@example.com",
};

/**
 * Ответ `/spaces` под голдены `spaces.json` и `boards.json`: три
 * пространства, три доски — все в первом (у досок своего `space_id` в
 * ответе нет, он берётся от родителя).
 */
const SPACES = [
  {
    id: 3001,
    title: "Пространство 1",
    archived: false,
    boards: [
      { id: 4001, title: "Доска 1" },
      { id: 4002, title: "Доска 2" },
      { id: 4003, title: "Доска 3" },
    ],
  },
  { id: 3002, title: "Пространство 2", archived: false, boards: [] },
  { id: 3003, title: "Пространство 3", archived: false, boards: [] },
];

/** Дорожки первой доски под голден `lanes.json`. */
const LANES = [
  { id: 5001, board_id: 4001, title: "Дорожка 1" },
  { id: 5002, board_id: 4001, title: "Дорожка 2" },
  { id: 5003, board_id: 4001, title: "Дорожка 3" },
];

/** Колонки первой доски под голден `columns.json`. */
const COLUMNS = [
  { id: 6001, board_id: 4001, title: "Колонка 1", sort_order: 1 },
  { id: 6002, board_id: 4001, title: "Колонка 2", sort_order: 2 },
  { id: 6003, board_id: 4001, title: "Колонка 3", sort_order: 3 },
  { id: 6004, board_id: 4001, title: "Колонка 4", sort_order: 4 },
];

/**
 * Роли под голден `roles.json`: три обычные и системная. Системная
 * узнаётся по неположительному id — в голдене канала её id
 * нормализацией заменён на положительный, поэтому голдены `roles.json` и
 * `roles-all.json` снимаются с разных входов (см. тесты ниже).
 */
const ROLES_WITH_SYSTEM = [
  { id: 7001, name: "Роль 1" },
  { id: 7002, name: "Роль 2" },
  { id: 7003, name: "Роль 3" },
  { id: -1, name: "Employee" },
];

/** Роли под голден `roles-all.json`: все четыре с положительным id. */
const ROLES_ALL = [
  { id: 7001, name: "Роль 1" },
  { id: 7002, name: "Роль 2" },
  { id: 7003, name: "Роль 3" },
  { id: 7999, name: "Системная роль" },
];

/** Чем отвечать на путь; путь вне таблицы — красный тест, а не пустота. */
type Routes = Readonly<Record<string, () => Response>>;

interface Stand {
  readonly io: CommandIo;
  readonly db: () => ReturnType<typeof openCacheDb>;
  readonly paths: () => readonly string[];
  readonly stop: () => Promise<void>;
}

/** Стенд: фейковый Kaiten со справочниками и настоящая кэш-БД. */
function stand(routes: Routes): Stand {
  const fake = startFakeKaiten((seen) => {
    const last = seen[seen.length - 1];
    const route = routes[last.pathname];
    return route === undefined
      ? new Response("путь, которого тест не ждал", { status: 500 })
      : route();
  });
  const values: Readonly<Record<string, string>> = {
    KITEN_API_KEY: "probe-key",
    KITEN_BASE_URL: fake.baseUrl,
  };
  const dir = Deno.makeTempDirSync();
  const io = makeFakeIo({
    envFile: {
      get: (name) => values[name],
      values: () => values,
      require: (name) => values[name] ?? "",
      set: () => Promise.resolve(),
    },
    // Кэш-БД настоящая: фейк проверял бы форму вызова, а не то, что
    // строка легла в таблицу схемы.
    openCacheDb: () => openCacheDb(`${dir}/cache.db`),
  });
  return {
    io,
    db: () => openCacheDb(`${dir}/cache.db`),
    paths: () => fake.seen.map((request) => request.pathname),
    stop: async () => {
      await fake.stop();
      Deno.removeSync(dir, { recursive: true });
    },
  };
}

/** Все справочники разом: стенд подкоманд, которым нужен весь набор. */
function fullRoutes(
  overrides: Record<string, () => Response> = {},
): Routes {
  return {
    [USER_PATH]: () => Response.json(USER),
    [SPACES_PATH]: () => Response.json(SPACES),
    [ROLES_PATH]: () => Response.json(ROLES_WITH_SYSTEM),
    [lanesPath(4001)]: () => Response.json(LANES),
    [lanesPath(4002)]: () => Response.json([]),
    [lanesPath(4003)]: () => Response.json([]),
    [columnsPath(4001)]: () => Response.json(COLUMNS),
    [columnsPath(4002)]: () => Response.json([]),
    [columnsPath(4003)]: () => Response.json([]),
    ...overrides,
  };
}

/** Текст, который команда печатает человеку. */
async function output(
  command: Command,
  argv: readonly string[],
  io: CommandIo,
): Promise<string> {
  return command.renderResult(await command.invoke(argv, io), argv);
}

function golden(name: string): Promise<string> {
  return Deno.readTextFile(
    new URL(`testdata/kiten-refs/${name}`, import.meta.url),
  );
}

/** Строки таблицы кэша по возрастанию id. */
function rows(
  st: Stand,
  sql: string,
): readonly Record<string, unknown>[] {
  using db = st.db();
  db.bootstrap();
  return db.query(sql) as unknown as readonly Record<string, unknown>[];
}

/** Строка дорожки от прошлого прогрева: её судьбу проверяет scoped-замена. */
function seedLane(
  st: Stand,
  lane: {
    readonly id: number;
    readonly boardId: number;
    readonly title: string;
  },
): void {
  using db = st.db();
  db.bootstrap();
  db.execute(
    "INSERT INTO kaiten_lanes (id, board_id, title, discovered_at) VALUES (?, ?, ?, ?)",
    lane.id,
    lane.boardId,
    lane.title,
    1_000,
  );
}

/** Порт без единого разрешённого обращения: ключа доступа в нём нет. */
function ioWithoutKey(): CommandIo {
  return makeFakeIo({});
}

Deno.test("whoami: --json — те же ключи в том же порядке, что в голдене", async () => {
  const st = stand({ [USER_PATH]: () => Response.json(USER) });
  try {
    const text = await output(kitenWhoamiCommand, ["--json"], st.io);

    // Голден канала снят с версии, печатавшей компактный однострочный
    // JSON (отклонение fix): байты не сверяются, сверяются состав и
    // порядок ключей.
    assertEquals(
      Object.keys(JSON.parse(text)),
      Object.keys(JSON.parse(await golden("whoami.json"))),
    );
    assertEquals(text, `${JSON.stringify(USER, null, 2)}\n`);
  } finally {
    await st.stop();
  }
});

Deno.test("whoami: текстовая форма — четыре строки и ни одного обращения к кэшу", async () => {
  // Кэш в порту не разрешён: тронет его команда — тест покраснеет.
  const fake = startFakeKaiten(() => Response.json(USER));
  const values = {
    KITEN_API_KEY: "probe-key",
    KITEN_BASE_URL: fake.baseUrl,
  } as Readonly<Record<string, string>>;
  const io = makeFakeIo({
    envFile: {
      get: (name) => values[name],
      values: () => values,
      require: (name) => values[name] ?? "",
      set: () => Promise.resolve(),
    },
  });
  try {
    assertEquals(
      await output(kitenWhoamiCommand, [], io),
      "id:    1001\n" +
        "name:  Иван Иванов\n" +
        "login: user001\n" +
        "email: user@example.com\n",
    );
  } finally {
    await fake.stop();
  }
});

Deno.test("spaces: --json совпадает с голденом байт-в-байт", async () => {
  const st = stand(fullRoutes());
  try {
    assertEquals(
      await output(kitenSpacesCommand, ["--json"], st.io),
      await golden("spaces.json"),
    );
  } finally {
    await st.stop();
  }
});

Deno.test("boards: --json совпадает с голденом байт-в-байт", async () => {
  const st = stand(fullRoutes());
  try {
    assertEquals(
      await output(kitenBoardsCommand, ["--json"], st.io),
      await golden("boards.json"),
    );
    // Отдельного списка досок у API нет — доски собраны из /spaces.
    assertEquals(st.paths(), [SPACES_PATH]);
  } finally {
    await st.stop();
  }
});

Deno.test("lanes: --json совпадает с голденом байт-в-байт", async () => {
  const st = stand(fullRoutes());
  try {
    assertEquals(
      await output(kitenLanesCommand, ["--json"], st.io),
      await golden("lanes.json"),
    );
    // Без фильтров скоуп — все доски компании.
    assertEquals(st.paths().length, 4);
  } finally {
    await st.stop();
  }
});

Deno.test("columns: --json совпадает с голденом байт-в-байт", async () => {
  const st = stand(fullRoutes());
  try {
    assertEquals(
      await output(kitenColumnsCommand, ["--json"], st.io),
      await golden("columns.json"),
    );
  } finally {
    await st.stop();
  }
});

Deno.test("roles: без --all системная роль скрыта, с --all — видна", async (t) => {
  await t.step("без --all — голден roles.json", async () => {
    const st = stand(fullRoutes());
    try {
      assertEquals(
        await output(kitenRolesCommand, ["--json"], st.io),
        await golden("roles.json"),
      );
    } finally {
      await st.stop();
    }
  });

  await t.step("--all — голден roles-all.json", async () => {
    // Вход другой: в голдене канала id системной роли нормализован в
    // положительный, и одним ответом обе формы не снимаются.
    const st = stand(
      fullRoutes({ [ROLES_PATH]: () => Response.json(ROLES_ALL) }),
    );
    try {
      assertEquals(
        await output(kitenRolesCommand, ["--json", "--all"], st.io),
        await golden("roles-all.json"),
      );
    } finally {
      await st.stop();
    }
  });

  await t.step("--all показывает роль с неположительным id", async () => {
    const st = stand(fullRoutes());
    try {
      const text = await output(kitenRolesCommand, ["--json", "--all"], st.io);
      assertEquals(JSON.parse(text), ROLES_WITH_SYSTEM);
    } finally {
      await st.stop();
    }
  });
});

Deno.test("скрытые из вывода строки всё равно попадают в кэш", async (t) => {
  await t.step("архивное пространство: нет в выводе, есть в кэше", async () => {
    const archived = [
      ...SPACES,
      { id: 3009, title: "Архивное", archived: true, boards: [] },
    ];
    const st = stand(
      fullRoutes({ [SPACES_PATH]: () => Response.json(archived) }),
    );
    try {
      const text = await output(kitenSpacesCommand, ["--json"], st.io);
      assertEquals(
        (JSON.parse(text) as { id: number }[]).map((space) => space.id),
        [3001, 3002, 3003],
      );
      assertEquals(
        rows(st, "SELECT id, archived FROM kaiten_spaces ORDER BY id"),
        [
          { id: 3001, archived: 0 },
          { id: 3002, archived: 0 },
          { id: 3003, archived: 0 },
          { id: 3009, archived: 1 },
        ],
      );
    } finally {
      await st.stop();
    }
  });

  await t.step("системная роль: нет в выводе, есть в кэше", async () => {
    const st = stand(fullRoutes());
    try {
      const text = await output(kitenRolesCommand, ["--json"], st.io);
      assertEquals(
        (JSON.parse(text) as { id: number }[]).map((role) => role.id),
        [7001, 7002, 7003],
      );
      assertEquals(
        rows(st, "SELECT id, name FROM kaiten_roles ORDER BY id"),
        [
          { id: -1, name: "Employee" },
          { id: 7001, name: "Роль 1" },
          { id: 7002, name: "Роль 2" },
          { id: 7003, name: "Роль 3" },
        ],
      );
    } finally {
      await st.stop();
    }
  });

  await t.step("--space не сужает запись досок в кэш", async () => {
    const st = stand(fullRoutes());
    try {
      const text = await output(
        kitenBoardsCommand,
        ["--json", "--space", "Пространство 2"],
        st.io,
      );
      assertEquals(JSON.parse(text), []);
      assertEquals(
        rows(st, "SELECT id FROM kaiten_boards ORDER BY id"),
        [{ id: 4001 }, { id: 4002 }, { id: 4003 }],
      );
    } finally {
      await st.stop();
    }
  });
});

Deno.test("roles: своя запись не стирает кэш пространств и досок", async () => {
  const st = stand(fullRoutes());
  try {
    await kitenSpacesCommand.invoke([], st.io);
    await kitenRolesCommand.invoke([], st.io);

    assertEquals(
      rows(st, "SELECT id FROM kaiten_spaces ORDER BY id").length,
      3,
    );
    assertEquals(
      rows(st, "SELECT id FROM kaiten_boards ORDER BY id").length,
      3,
    );
  } finally {
    await st.stop();
  }
});

Deno.test("lanes: доска с ошибкой пропущена, обход продолжается", async () => {
  const st = stand(fullRoutes({
    [lanesPath(4002)]: () => new Response("нет доступа", { status: 403 }),
    [lanesPath(4003)]: () =>
      Response.json([
        { id: 5100, board_id: 4003, title: "Дорожка третьей доски" },
      ]),
  }));
  try {
    seedLane(st, {
      id: 5900,
      boardId: 4002,
      title: "Дорожка из прошлого прогрева",
    });

    const text = await output(kitenLanesCommand, ["--json"], st.io);

    // Отказ одной доски не роняет команду и не убирает соседние.
    assertEquals(
      (JSON.parse(text) as { id: number }[]).map((lane) => lane.id),
      [5001, 5002, 5003, 5100],
    );
    // Замена — только по обойдённым доскам: строка отказавшей доски,
    // лежавшая в кэше до запуска, осталась цела.
    assertEquals(
      rows(st, "SELECT id, board_id FROM kaiten_lanes ORDER BY id"),
      [
        { id: 5001, board_id: 4001 },
        { id: 5002, board_id: 4001 },
        { id: 5003, board_id: 4001 },
        { id: 5100, board_id: 4003 },
        { id: 5900, board_id: 4002 },
      ],
    );
  } finally {
    await st.stop();
  }
});

Deno.test("lanes: отказ ВСЕХ досок скоупа — пустая выдача, а не ошибка", async () => {
  const denied = () => new Response("нет доступа", { status: 403 });
  const st = stand(fullRoutes({
    [lanesPath(4001)]: denied,
    [lanesPath(4002)]: denied,
    [lanesPath(4003)]: denied,
  }));
  try {
    assertEquals(await output(kitenLanesCommand, ["--json"], st.io), "[]\n");
    assertEquals(
      await output(kitenLanesCommand, [], st.io),
      "(нет дорожек)\n",
    );
  } finally {
    await st.stop();
  }
});

Deno.test("columns: отказ ВСЕХ досок скоупа — пустая выдача, а не ошибка", async () => {
  const denied = () => new Response("нет доступа", { status: 403 });
  const st = stand(fullRoutes({
    [columnsPath(4001)]: denied,
    [columnsPath(4002)]: denied,
    [columnsPath(4003)]: denied,
  }));
  try {
    assertEquals(await output(kitenColumnsCommand, ["--json"], st.io), "[]\n");
    assertEquals(
      await output(kitenColumnsCommand, [], st.io),
      "(нет колонок)\n",
    );
  } finally {
    await st.stop();
  }
});

Deno.test("скоуп дорожек и колонок: --board, --space, без фильтров", async (t) => {
  await t.step("--board — запрос только на эту доску", async () => {
    const st = stand(fullRoutes());
    try {
      assertEquals(
        await output(
          kitenLanesCommand,
          ["--json", "--board", "Доска 1"],
          st.io,
        ),
        await golden("lanes.json"),
      );
      assertEquals(st.paths(), [SPACES_PATH, lanesPath(4001)]);
    } finally {
      await st.stop();
    }
  });

  await t.step("--space — доски пространства", async () => {
    const st = stand(fullRoutes());
    try {
      await kitenColumnsCommand.invoke(["--space", "3001"], st.io);
      assertEquals(st.paths(), [
        SPACES_PATH,
        columnsPath(4001),
        columnsPath(4002),
        columnsPath(4003),
      ]);
    } finally {
      await st.stop();
    }
  });

  await t.step("--space без досок — пустая выдача", async () => {
    const st = stand(fullRoutes());
    try {
      assertEquals(
        await output(kitenLanesCommand, ["--space", "Пространство 3"], st.io),
        "(нет дорожек)\n",
      );
      assertEquals(st.paths(), [SPACES_PATH]);
    } finally {
      await st.stop();
    }
  });
});

Deno.test("текстовые формы: колонки и итог", async (t) => {
  const cases: readonly {
    readonly name: string;
    readonly command: Command;
    readonly argv: readonly string[];
    readonly header: readonly string[];
    readonly footer: string;
  }[] = [
    {
      name: "spaces",
      command: kitenSpacesCommand,
      argv: [],
      header: ["ID", "TITLE", "ARCHIVED"],
      footer: "(3 spaces)",
    },
    {
      name: "boards",
      command: kitenBoardsCommand,
      argv: [],
      header: ["ID", "SPACE", "TITLE"],
      footer: "(3 boards)",
    },
    {
      name: "lanes",
      command: kitenLanesCommand,
      argv: [],
      header: ["ID", "BOARD", "TITLE"],
      footer: "(3 lanes)",
    },
    {
      name: "columns",
      command: kitenColumnsCommand,
      argv: [],
      header: ["ID", "BOARD", "TITLE"],
      footer: "(4 columns)",
    },
    {
      name: "roles",
      command: kitenRolesCommand,
      argv: [],
      header: ["ID", "NAME"],
      footer: "(3 roles)",
    },
  ];

  for (const item of cases) {
    await t.step(item.name, async () => {
      const st = stand(fullRoutes());
      try {
        const text = await output(item.command, item.argv, st.io);
        const lines = text.split("\n");

        // Ширина колонок — оформление, а не контракт: сверяется их
        // состав и порядок.
        assertEquals(lines[0].split(/\s+/), item.header);
        assertEquals(lines[lines.length - 2], item.footer);
      } finally {
        await st.stop();
      }
    });
  }

  await t.step("spaces: архивное помечено yes", async () => {
    const archived = [
      { id: 3009, title: "Архивное", archived: true, boards: [] },
    ];
    const st = stand(
      fullRoutes({ [SPACES_PATH]: () => Response.json(archived) }),
    );
    try {
      assertEquals(
        await output(kitenSpacesCommand, ["--all"], st.io),
        "ID    TITLE     ARCHIVED\n3009  Архивное  yes\n(1 spaces)\n",
      );
    } finally {
      await st.stop();
    }
  });
});

Deno.test("пустой ответ /spaces: пустые выдачи и пустые таблицы кэша", async () => {
  const st = stand(fullRoutes({ [SPACES_PATH]: () => Response.json([]) }));
  try {
    assertEquals(
      await output(kitenSpacesCommand, [], st.io),
      "(нет пространств)\n",
    );
    assertEquals(await output(kitenBoardsCommand, ["--json"], st.io), "[]\n");
    assertEquals(await output(kitenLanesCommand, [], st.io), "(нет дорожек)\n");
    assertEquals(rows(st, "SELECT id FROM kaiten_spaces"), []);
    assertEquals(rows(st, "SELECT id FROM kaiten_boards"), []);
  } finally {
    await st.stop();
  }
});

Deno.test("нет KITEN_API_KEY — ошибка ввода (exit 2) до всякой сети", async (t) => {
  const commands: readonly Command[] = [
    kitenWhoamiCommand,
    kitenSpacesCommand,
    kitenBoardsCommand,
    kitenLanesCommand,
    kitenColumnsCommand,
    kitenRolesCommand,
  ];
  for (const command of commands) {
    await t.step(command.errorName, async () => {
      const err = await assertRejects(
        () => command.invoke([], ioWithoutKey()),
        UsageError,
      );
      assertEquals(err.message, "KITEN_API_KEY не задан");
    });
  }
});

Deno.test("ошибка API — exit 1 и одинарный префикс в stderr", async (t) => {
  await t.step("spaces", async () => {
    const st = stand(
      fullRoutes({
        [SPACES_PATH]: () => new Response("сервер прилёг", { status: 500 }),
      }),
    );
    try {
      const err = await assertRejects(
        () => kitenSpacesCommand.invoke([], st.io),
        DomainError,
      );
      const line = formatCommandError(kitenSpacesCommand.errorName, err);
      assertEquals(
        line,
        "mpu kiten spaces: kaiten error: kaiten GET /spaces -> 500: сервер прилёг",
      );
      // Префикс ровно один: удвоение — отклонение с вердиктом fix.
      assertEquals(line.split("kaiten error:").length, 2);
    } finally {
      await st.stop();
    }
  });

  await t.step("whoami", async () => {
    const st = stand({
      [USER_PATH]: () => new Response("нет доступа", { status: 403 }),
    });
    try {
      const err = await assertRejects(
        () => kitenWhoamiCommand.invoke([], st.io),
        DomainError,
      );
      assertStringIncludes(
        formatCommandError(kitenWhoamiCommand.errorName, err),
        "mpu kiten whoami: kaiten error: kaiten GET /users/current -> 403:",
      );
    } finally {
      await st.stop();
    }
  });

  await t.step("roles", async () => {
    const st = stand(
      fullRoutes({
        [ROLES_PATH]: () => new Response("сервер прилёг", { status: 500 }),
      }),
    );
    try {
      const err = await assertRejects(
        () => kitenRolesCommand.invoke([], st.io),
        DomainError,
      );
      assertEquals(
        formatCommandError(kitenRolesCommand.errorName, err),
        "mpu kiten roles: kaiten error: kaiten GET /user-roles -> 500: сервер прилёг",
      );
    } finally {
      await st.stop();
    }
  });
});

Deno.test("нерезолвящийся REF — ошибка ввода (exit 2)", async (t) => {
  await t.step("--space", async () => {
    const st = stand(fullRoutes());
    try {
      const err = await assertRejects(
        () => kitenBoardsCommand.invoke(["--space", "Нет такого"], st.io),
        UsageError,
      );
      assertStringIncludes(err.message, "space 'Нет такого' не найден");
    } finally {
      await st.stop();
    }
  });

  await t.step("--board", async () => {
    const st = stand(fullRoutes());
    try {
      const err = await assertRejects(
        () => kitenLanesCommand.invoke(["--board", "9999"], st.io),
        UsageError,
      );
      assertStringIncludes(err.message, "board '9999' не найден");
      // Кэш уже обновлён ответом: резолв идёт по нему, а не наоборот.
      assertEquals(
        rows(st, "SELECT id FROM kaiten_boards ORDER BY id").length,
        3,
      );
    } finally {
      await st.stop();
    }
  });
});
