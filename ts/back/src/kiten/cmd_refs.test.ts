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

import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rejected } from "../testing/thrown.ts";
import { plainRows } from "../testing/cache.ts";
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
  const dir = mkdtempSync(join(tmpdir(), "mpu-"));
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
      rmSync(dir, { recursive: true });
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
  return readFile(
    new URL(`testdata/kiten-refs/${name}`, import.meta.url),
    "utf8",
  );
}

/** Строки таблицы кэша по возрастанию id. */
function rows(
  st: Stand,
  sql: string,
): readonly Record<string, unknown>[] {
  using db = st.db();
  db.bootstrap();
  // Строки драйвера — записи без прототипа: сверяются копии (`plainRows`).
  return plainRows(db.query(sql));
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

it("whoami: --json — те же ключи в том же порядке, что в голдене", async () => {
  const st = stand({ [USER_PATH]: () => Response.json(USER) });
  try {
    const text = await output(kitenWhoamiCommand, ["--json"], st.io);

    // Голден канала снят с версии, печатавшей компактный однострочный
    // JSON (отклонение fix): байты не сверяются, сверяются состав и
    // порядок ключей.
    expect(Object.keys(JSON.parse(text))).toStrictEqual(
      Object.keys(JSON.parse(await golden("whoami.json"))),
    );
    expect(text).toStrictEqual(`${JSON.stringify(USER, null, 2)}\n`);
  } finally {
    await st.stop();
  }
});

it("whoami: текстовая форма — четыре строки и ни одного обращения к кэшу", async () => {
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
    expect(await output(kitenWhoamiCommand, [], io)).toStrictEqual(
      "id:    1001\n" +
        "name:  Иван Иванов\n" +
        "login: user001\n" +
        "email: user@example.com\n",
    );
  } finally {
    await fake.stop();
  }
});

it("spaces: --json совпадает с голденом байт-в-байт", async () => {
  const st = stand(fullRoutes());
  try {
    expect(await output(kitenSpacesCommand, ["--json"], st.io)).toStrictEqual(
      await golden("spaces.json"),
    );
  } finally {
    await st.stop();
  }
});

it("boards: --json совпадает с голденом байт-в-байт", async () => {
  const st = stand(fullRoutes());
  try {
    expect(await output(kitenBoardsCommand, ["--json"], st.io)).toStrictEqual(
      await golden("boards.json"),
    );
    // Отдельного списка досок у API нет — доски собраны из /spaces.
    expect(st.paths()).toStrictEqual([SPACES_PATH]);
  } finally {
    await st.stop();
  }
});

it("lanes: --json совпадает с голденом байт-в-байт", async () => {
  const st = stand(fullRoutes());
  try {
    expect(await output(kitenLanesCommand, ["--json"], st.io)).toStrictEqual(
      await golden("lanes.json"),
    );
    // Без фильтров скоуп — все доски компании.
    expect(st.paths().length).toBe(4);
  } finally {
    await st.stop();
  }
});

it("columns: --json совпадает с голденом байт-в-байт", async () => {
  const st = stand(fullRoutes());
  try {
    expect(await output(kitenColumnsCommand, ["--json"], st.io)).toStrictEqual(
      await golden("columns.json"),
    );
  } finally {
    await st.stop();
  }
});

describe("roles: без --all системная роль скрыта, с --all — видна", () => {
  it("без --all — голден roles.json", async () => {
    const st = stand(fullRoutes());
    try {
      expect(await output(kitenRolesCommand, ["--json"], st.io)).toStrictEqual(
        await golden("roles.json"),
      );
    } finally {
      await st.stop();
    }
  });

  it("--all — голден roles-all.json", async () => {
    // Вход другой: в голдене канала id системной роли нормализован в
    // положительный, и одним ответом обе формы не снимаются.
    const st = stand(
      fullRoutes({ [ROLES_PATH]: () => Response.json(ROLES_ALL) }),
    );
    try {
      expect(await output(kitenRolesCommand, ["--json", "--all"], st.io))
        .toStrictEqual(await golden("roles-all.json"));
    } finally {
      await st.stop();
    }
  });

  it("--all показывает роль с неположительным id", async () => {
    const st = stand(fullRoutes());
    try {
      const text = await output(kitenRolesCommand, ["--json", "--all"], st.io);
      expect(JSON.parse(text)).toStrictEqual(ROLES_WITH_SYSTEM);
    } finally {
      await st.stop();
    }
  });
});

describe("скрытые из вывода строки всё равно попадают в кэш", () => {
  it("архивное пространство: нет в выводе, есть в кэше", async () => {
    const archived = [
      ...SPACES,
      { id: 3009, title: "Архивное", archived: true, boards: [] },
    ];
    const st = stand(
      fullRoutes({ [SPACES_PATH]: () => Response.json(archived) }),
    );
    try {
      const text = await output(kitenSpacesCommand, ["--json"], st.io);
      expect((JSON.parse(text) as { id: number }[]).map((space) => space.id))
        .toStrictEqual([3001, 3002, 3003]);
      expect(rows(st, "SELECT id, archived FROM kaiten_spaces ORDER BY id"))
        .toStrictEqual([
          { id: 3001, archived: 0 },
          { id: 3002, archived: 0 },
          { id: 3003, archived: 0 },
          { id: 3009, archived: 1 },
        ]);
    } finally {
      await st.stop();
    }
  });

  it("системная роль: нет в выводе, есть в кэше", async () => {
    const st = stand(fullRoutes());
    try {
      const text = await output(kitenRolesCommand, ["--json"], st.io);
      expect((JSON.parse(text) as { id: number }[]).map((role) => role.id))
        .toStrictEqual([7001, 7002, 7003]);
      expect(rows(st, "SELECT id, name FROM kaiten_roles ORDER BY id"))
        .toStrictEqual([
          { id: -1, name: "Employee" },
          { id: 7001, name: "Роль 1" },
          { id: 7002, name: "Роль 2" },
          { id: 7003, name: "Роль 3" },
        ]);
    } finally {
      await st.stop();
    }
  });

  it("--space не сужает запись досок в кэш", async () => {
    const st = stand(fullRoutes());
    try {
      const text = await output(
        kitenBoardsCommand,
        ["--json", "--space", "Пространство 2"],
        st.io,
      );
      expect(JSON.parse(text)).toStrictEqual([]);
      expect(rows(st, "SELECT id FROM kaiten_boards ORDER BY id"))
        .toStrictEqual([{ id: 4001 }, { id: 4002 }, { id: 4003 }]);
    } finally {
      await st.stop();
    }
  });
});

it("roles: своя запись не стирает кэш пространств и досок", async () => {
  const st = stand(fullRoutes());
  try {
    await kitenSpacesCommand.invoke([], st.io);
    await kitenRolesCommand.invoke([], st.io);

    expect(rows(st, "SELECT id FROM kaiten_spaces ORDER BY id").length).toBe(3);
    expect(rows(st, "SELECT id FROM kaiten_boards ORDER BY id").length).toBe(3);
  } finally {
    await st.stop();
  }
});

it("lanes: доска с ошибкой пропущена, обход продолжается", async () => {
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
    expect((JSON.parse(text) as { id: number }[]).map((lane) => lane.id))
      .toStrictEqual([5001, 5002, 5003, 5100]);
    // Замена — только по обойдённым доскам: строка отказавшей доски,
    // лежавшая в кэше до запуска, осталась цела.
    expect(rows(st, "SELECT id, board_id FROM kaiten_lanes ORDER BY id"))
      .toStrictEqual([
        { id: 5001, board_id: 4001 },
        { id: 5002, board_id: 4001 },
        { id: 5003, board_id: 4001 },
        { id: 5100, board_id: 4003 },
        { id: 5900, board_id: 4002 },
      ]);
  } finally {
    await st.stop();
  }
});

it("lanes: отказ ВСЕХ досок скоупа — пустая выдача, а не ошибка", async () => {
  const denied = () => new Response("нет доступа", { status: 403 });
  const st = stand(fullRoutes({
    [lanesPath(4001)]: denied,
    [lanesPath(4002)]: denied,
    [lanesPath(4003)]: denied,
  }));
  try {
    expect(await output(kitenLanesCommand, ["--json"], st.io)).toBe("[]\n");
    expect(await output(kitenLanesCommand, [], st.io)).toBe("(нет дорожек)\n");
  } finally {
    await st.stop();
  }
});

it("columns: отказ ВСЕХ досок скоупа — пустая выдача, а не ошибка", async () => {
  const denied = () => new Response("нет доступа", { status: 403 });
  const st = stand(fullRoutes({
    [columnsPath(4001)]: denied,
    [columnsPath(4002)]: denied,
    [columnsPath(4003)]: denied,
  }));
  try {
    expect(await output(kitenColumnsCommand, ["--json"], st.io)).toBe("[]\n");
    expect(await output(kitenColumnsCommand, [], st.io)).toBe(
      "(нет колонок)\n",
    );
  } finally {
    await st.stop();
  }
});

describe("скоуп дорожек и колонок: --board, --space, без фильтров", () => {
  it("--board — запрос только на эту доску", async () => {
    const st = stand(fullRoutes());
    try {
      expect(
        await output(
          kitenLanesCommand,
          ["--json", "--board", "Доска 1"],
          st.io,
        ),
      ).toStrictEqual(await golden("lanes.json"));
      expect(st.paths()).toStrictEqual([SPACES_PATH, lanesPath(4001)]);
    } finally {
      await st.stop();
    }
  });

  it("--space — доски пространства", async () => {
    const st = stand(fullRoutes());
    try {
      await kitenColumnsCommand.invoke(["--space", "3001"], st.io);
      expect(st.paths()).toStrictEqual([
        SPACES_PATH,
        columnsPath(4001),
        columnsPath(4002),
        columnsPath(4003),
      ]);
    } finally {
      await st.stop();
    }
  });

  it("--space без досок — пустая выдача", async () => {
    const st = stand(fullRoutes());
    try {
      expect(
        await output(kitenLanesCommand, ["--space", "Пространство 3"], st.io),
      ).toBe("(нет дорожек)\n");
      expect(st.paths()).toStrictEqual([SPACES_PATH]);
    } finally {
      await st.stop();
    }
  });
});

describe("текстовые формы: колонки и итог", () => {
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
    it(item.name, async () => {
      const st = stand(fullRoutes());
      try {
        const text = await output(item.command, item.argv, st.io);
        const lines = text.split("\n");

        // Ширина колонок — оформление, а не контракт: сверяется их
        // состав и порядок.
        expect(lines[0].split(/\s+/)).toStrictEqual(item.header);
        expect(lines[lines.length - 2]).toStrictEqual(item.footer);
      } finally {
        await st.stop();
      }
    });
  }

  it("spaces: архивное помечено yes", async () => {
    const archived = [
      { id: 3009, title: "Архивное", archived: true, boards: [] },
    ];
    const st = stand(
      fullRoutes({ [SPACES_PATH]: () => Response.json(archived) }),
    );
    try {
      expect(await output(kitenSpacesCommand, ["--all"], st.io)).toBe(
        "ID    TITLE     ARCHIVED\n3009  Архивное  yes\n(1 spaces)\n",
      );
    } finally {
      await st.stop();
    }
  });
});

it("пустой ответ /spaces: пустые выдачи и пустые таблицы кэша", async () => {
  const st = stand(fullRoutes({ [SPACES_PATH]: () => Response.json([]) }));
  try {
    expect(await output(kitenSpacesCommand, [], st.io)).toBe(
      "(нет пространств)\n",
    );
    expect(await output(kitenBoardsCommand, ["--json"], st.io)).toBe("[]\n");
    expect(await output(kitenLanesCommand, [], st.io)).toBe("(нет дорожек)\n");
    expect(rows(st, "SELECT id FROM kaiten_spaces")).toStrictEqual([]);
    expect(rows(st, "SELECT id FROM kaiten_boards")).toStrictEqual([]);
  } finally {
    await st.stop();
  }
});

describe("нет KITEN_API_KEY — ошибка ввода (exit 2) до всякой сети", () => {
  const commands: readonly Command[] = [
    kitenWhoamiCommand,
    kitenSpacesCommand,
    kitenBoardsCommand,
    kitenLanesCommand,
    kitenColumnsCommand,
    kitenRolesCommand,
  ];
  for (const command of commands) {
    it(command.errorName, async () => {
      const err = await rejected(
        () => command.invoke([], ioWithoutKey()),
        UsageError,
      );
      expect(err.message).toBe("KITEN_API_KEY не задан");
    });
  }
});

describe("ошибка API — exit 1 и одинарный префикс в stderr", () => {
  it("spaces", async () => {
    const st = stand(
      fullRoutes({
        [SPACES_PATH]: () => new Response("сервер прилёг", { status: 500 }),
      }),
    );
    try {
      const err = await rejected(
        () => kitenSpacesCommand.invoke([], st.io),
        DomainError,
      );
      const line = formatCommandError(kitenSpacesCommand.errorName, err);
      expect(line).toBe(
        "mpu kiten spaces: kaiten error: kaiten GET /spaces -> 500: сервер прилёг",
      );
      // Префикс ровно один: удвоение — отклонение с вердиктом fix.
      expect(line.split("kaiten error:").length).toBe(2);
    } finally {
      await st.stop();
    }
  });

  it("whoami", async () => {
    const st = stand({
      [USER_PATH]: () => new Response("нет доступа", { status: 403 }),
    });
    try {
      const err = await rejected(
        () => kitenWhoamiCommand.invoke([], st.io),
        DomainError,
      );
      expect(formatCommandError(kitenWhoamiCommand.errorName, err)).toContain(
        "mpu kiten whoami: kaiten error: kaiten GET /users/current -> 403:",
      );
    } finally {
      await st.stop();
    }
  });

  it("roles", async () => {
    const st = stand(
      fullRoutes({
        [ROLES_PATH]: () => new Response("сервер прилёг", { status: 500 }),
      }),
    );
    try {
      const err = await rejected(
        () => kitenRolesCommand.invoke([], st.io),
        DomainError,
      );
      expect(formatCommandError(kitenRolesCommand.errorName, err)).toBe(
        "mpu kiten roles: kaiten error: kaiten GET /user-roles -> 500: сервер прилёг",
      );
    } finally {
      await st.stop();
    }
  });
});

describe("нерезолвящийся REF — ошибка ввода (exit 2)", () => {
  it("--space", async () => {
    const st = stand(fullRoutes());
    try {
      const err = await rejected(() =>
        kitenBoardsCommand.invoke(
          ["--space", "Нет такого"],
          st.io,
        ), UsageError);
      expect(err.message).toContain("space 'Нет такого' не найден");
    } finally {
      await st.stop();
    }
  });

  it("--board", async () => {
    const st = stand(fullRoutes());
    try {
      const err = await rejected(
        () => kitenLanesCommand.invoke(["--board", "9999"], st.io),
        UsageError,
      );
      expect(err.message).toContain("board '9999' не найден");
      // Кэш уже обновлён ответом: резолв идёт по нему, а не наоборот.
      expect(rows(st, "SELECT id FROM kaiten_boards ORDER BY id").length).toBe(
        3,
      );
    } finally {
      await st.stop();
    }
  });
});
