/**
 * `mpu kiten ls` (`docs/specs/kiten-ls.md`): свод фильтров по осям
 * CLI-флаг → env → дефолт, глобальный режим дат и четыре машиночитаемых
 * вида вывода поверх таблицы по умолчанию.
 *
 * Вход тестов — фейковый Kaiten на петле (`../kaiten/testing.ts`) и
 * настоящая кэш-БД во временном каталоге: резолв `REF` и подпись колонки
 * читают её саму, а не мок. Вызов идёт от argv, как из точки входа.
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
import { type CapturedRequest, startFakeKaiten } from "../kaiten/testing.ts";
import { kitenLsCommand } from "./mod.ts";

const USER_PATH = "/api/latest/users/current";
const CARDS_PATH = "/api/latest/cards";

const USER = {
  id: 9001,
  full_name: "Тест Тестов",
  username: "tester",
  email: "tester@example.com",
};

/** Три карточки под голдены `ls-global.json`/`ls-global.md`. */
const GOLDEN_CARDS: readonly Record<string, unknown>[] = [
  {
    id: 68000001,
    title: "Тестовая карточка один",
    state: 3,
    due_date: "2026-07-23T00:00:00.000Z",
    updated: "2026-08-19T10:18:56.323Z",
    column_id: 9101,
  },
  {
    id: 68000002,
    title: "Тестовая карточка два",
    state: 3,
    due_date: "2026-07-23T00:00:00.000Z",
    updated: "2026-08-19T10:18:56.323Z",
    column_id: 9102,
  },
  {
    id: 68000003,
    title: "Тестовая карточка три",
    state: 3,
    due_date: "2026-07-24T00:00:00.000Z",
    updated: "2026-08-19T10:18:56.323Z",
    column_id: 9101,
  },
];

interface Stand {
  readonly io: CommandIo;
  readonly baseUrl: string;
  readonly seen: () => readonly CapturedRequest[];
  readonly db: () => ReturnType<typeof openCacheDb>;
  readonly warnings: readonly string[];
  readonly stop: () => Promise<void>;
}

/** Стенд: фейковый Kaiten, отвечающий `/users/current` и `/cards`. */
function stand(
  options: {
    readonly cards?: readonly Record<string, unknown>[];
    readonly user?: Record<string, unknown>;
    readonly env?: Record<string, string>;
  } = {},
): Stand {
  const cards = options.cards ?? [];
  const user = options.user ?? USER;
  const fake = startFakeKaiten((seen) => {
    const last = seen[seen.length - 1];
    if (last.pathname === USER_PATH) return Response.json(user);
    if (last.pathname === CARDS_PATH) {
      const offset = new URLSearchParams(last.search).get("offset");
      return Response.json(offset === "0" || offset === null ? cards : []);
    }
    return new Response("путь, которого тест не ждал", { status: 500 });
  });
  const values: Readonly<Record<string, string>> = {
    KITEN_API_KEY: "probe-key",
    KITEN_BASE_URL: fake.baseUrl,
    ...options.env,
  };
  const warnings: string[] = [];
  const dir = Deno.makeTempDirSync();
  const io = makeFakeIo({
    envFile: {
      get: (name) => values[name],
      values: () => values,
      require: (name) => values[name] ?? "",
      set: () => Promise.resolve(),
    },
    progress: (line) => void warnings.push(line),
    // Кэш-БД настоящая: фейк проверял бы форму вызова, а не то, что
    // резолв и подпись колонки читают именно таблицы схемы.
    openCacheDb: () => openCacheDb(`${dir}/cache.db`),
  });
  return {
    io,
    baseUrl: fake.baseUrl,
    seen: () => fake.seen,
    db: () => openCacheDb(`${dir}/cache.db`),
    warnings,
    stop: async () => {
      await fake.stop();
      Deno.removeSync(dir, { recursive: true });
    },
  };
}

/** Env-файл без единого разрешённого обращения к кэшу. */
function ioWithoutCache(
  env: Record<string, string>,
  fakeBaseUrl: string,
): CommandIo {
  const values: Readonly<Record<string, string>> = {
    KITEN_API_KEY: "probe-key",
    KITEN_BASE_URL: fakeBaseUrl,
    ...env,
  };
  return makeFakeIo({
    envFile: {
      get: (name) => values[name],
      values: () => values,
      require: (name) => values[name] ?? "",
      set: () => Promise.resolve(),
    },
    // openCacheDb намеренно не переопределён: тронет её команда, тест
    // покраснеет ("openCacheDb must not be touched").
  });
}

function golden(name: string): Promise<string> {
  return Deno.readTextFile(
    new URL(`testdata/kiten-ls/${name}`, import.meta.url),
  );
}

/** Голден с адресом стенда вместо `https://btlz.kaiten.ru` из канала. */
async function expected(name: string, baseUrl: string): Promise<string> {
  return (await golden(name)).replaceAll("https://btlz.kaiten.ru", baseUrl);
}

/** Текст, который команда печатает человеку. */
async function output(
  command: Command,
  argv: readonly string[],
  io: CommandIo,
): Promise<string> {
  return command.renderResult(await command.invoke(argv, io), argv);
}

/** Текст отказа так, как его напечатает точка входа, с переводом строки. */
async function errorText(
  argv: readonly string[],
  io: CommandIo,
  kind: typeof UsageError | typeof DomainError = UsageError,
): Promise<string> {
  const err = await assertRejects(() => kitenLsCommand.invoke(argv, io), kind);
  return `${formatCommandError(kitenLsCommand.errorName, err)}\n`;
}

/** Строка колонки в кэше. */
function seedColumn(
  st: Stand,
  column: {
    readonly id: number;
    readonly boardId: number;
    readonly title: string;
  },
): void {
  using db = st.db();
  db.bootstrap();
  db.execute(
    "INSERT INTO kaiten_columns (id, board_id, title, discovered_at) VALUES (?, ?, ?, ?)",
    column.id,
    column.boardId,
    column.title,
    1_000,
  );
}

/** Строка доски в кэше. */
function seedBoard(
  st: Stand,
  board: {
    readonly id: number;
    readonly spaceId: number;
    readonly title: string;
  },
): void {
  using db = st.db();
  db.bootstrap();
  db.execute(
    "INSERT INTO kaiten_boards (id, space_id, title, discovered_at) VALUES (?, ?, ?, ?)",
    board.id,
    board.spaceId,
    board.title,
    1_000,
  );
}

/** Строка дорожки в кэше. */
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

/** Query-параметры последнего запроса `/cards`. */
function cardsQueryOf(st: Stand): URLSearchParams {
  const request = st.seen().find((req) => req.pathname === CARDS_PATH);
  if (request === undefined) throw new Error("запроса /cards не было");
  return new URLSearchParams(request.search);
}

Deno.test("ls: --json совпадает с голденом байт-в-байт (глобальный режим)", async () => {
  const st = stand({ cards: GOLDEN_CARDS });
  try {
    const text = await output(kitenLsCommand, [
      "--date-from",
      "2026-07-01",
      "--date-to",
      "2026-08-19",
      "--json",
    ], st.io);
    assertEquals(text, await expected("ls-global.json", st.baseUrl));
  } finally {
    await st.stop();
  }
});

Deno.test("ls: --md совпадает с голденом байт-в-байт (глобальный режим)", async () => {
  const st = stand({ cards: GOLDEN_CARDS });
  try {
    seedColumn(st, { id: 9101, boardId: 4001, title: "Колонка 1" });
    seedColumn(st, { id: 9102, boardId: 4001, title: "Колонка 2" });
    const text = await output(kitenLsCommand, [
      "--date-from",
      "2026-07-01",
      "--date-to",
      "2026-08-19",
      "--md",
    ], st.io);
    assertEquals(text, await expected("ls-global.md", st.baseUrl));
  } finally {
    await st.stop();
  }
});

Deno.test("ls: --json не несёт колонку, доску и дорожку — ровно шесть ключей", async () => {
  const st = stand({ cards: GOLDEN_CARDS });
  try {
    seedColumn(st, { id: 9101, boardId: 4001, title: "Колонка 1" });
    const text = await output(kitenLsCommand, ["--json"], st.io);
    const rows = JSON.parse(text) as readonly Record<string, unknown>[];
    assertEquals(rows.length, 3);
    for (const row of rows) {
      assertEquals(
        Object.keys(row).sort(),
        ["due_date", "id", "state", "title", "updated", "url"],
      );
    }
  } finally {
    await st.stop();
  }
});

Deno.test("ls: --json не трогает кэш вовсе, если REF не задан", async () => {
  const fake = startFakeKaiten((seen) => {
    const last = seen[seen.length - 1];
    if (last.pathname === USER_PATH) return Response.json(USER);
    if (last.pathname === CARDS_PATH) return Response.json(GOLDEN_CARDS);
    return new Response("путь, которого тест не ждал", { status: 500 });
  });
  const io = ioWithoutCache({}, fake.baseUrl);
  try {
    const text = await output(kitenLsCommand, ["--json"], io);
    assertEquals((JSON.parse(text) as unknown[]).length, 3);
  } finally {
    await fake.stop();
  }
});

Deno.test("ls: приоритет видов вывода — json > format > only-url > md", async (t) => {
  await t.step("--json побеждает остальные флаги вида", async () => {
    const st = stand({ cards: [GOLDEN_CARDS[0]] });
    try {
      const text = await output(kitenLsCommand, [
        "--json",
        "--format",
        "{id}",
        "--only-url",
        "--md",
      ], st.io);
      assertEquals(text.startsWith("["), true);
    } finally {
      await st.stop();
    }
  });

  await t.step("--format побеждает --only-url и --md", async () => {
    const st = stand({ cards: [GOLDEN_CARDS[0]] });
    try {
      const text = await output(kitenLsCommand, [
        "--format",
        "F{id}",
        "--only-url",
        "--md",
      ], st.io);
      assertEquals(text, "F68000001\n");
    } finally {
      await st.stop();
    }
  });

  await t.step("--only-url побеждает --md", async () => {
    const st = stand({ cards: [GOLDEN_CARDS[0]] });
    try {
      const text = await output(kitenLsCommand, ["--only-url", "--md"], st.io);
      assertStringIncludes(text, "](");
      assertEquals(text.includes("| ID |"), false);
    } finally {
      await st.stop();
    }
  });
});

Deno.test("ls: свод оси condition — CLI > env > дефолт, --archived побеждает всегда", async (t) => {
  await t.step("дефолт condition=1 без флагов и env", async () => {
    const st = stand();
    try {
      await output(kitenLsCommand, [], st.io);
      assertEquals(cardsQueryOf(st).get("condition"), "1");
    } finally {
      await st.stop();
    }
  });

  await t.step("env KITEN_LS_CONDITION побеждает дефолт", async () => {
    const st = stand({ env: { KITEN_LS_CONDITION: "2" } });
    try {
      await output(kitenLsCommand, [], st.io);
      assertEquals(cardsQueryOf(st).get("condition"), "2");
    } finally {
      await st.stop();
    }
  });

  await t.step("--archived побеждает env", async () => {
    const st = stand({ env: { KITEN_LS_CONDITION: "1" } });
    try {
      await output(kitenLsCommand, ["--archived"], st.io);
      assertEquals(cardsQueryOf(st).get("condition"), "2");
    } finally {
      await st.stop();
    }
  });
});

Deno.test("ls: свод оси states — --state мапится, env уходит как есть, CLI побеждает", async (t) => {
  await t.step("--state мапится в код сервера", async () => {
    const st = stand();
    try {
      await output(kitenLsCommand, ["--state", "in-progress"], st.io);
      assertEquals(cardsQueryOf(st).get("states"), "2");
    } finally {
      await st.stop();
    }
  });

  await t.step("env KITEN_LS_STATES уходит дословно", async () => {
    const st = stand({ env: { KITEN_LS_STATES: "1,3" } });
    try {
      await output(kitenLsCommand, [], st.io);
      assertEquals(cardsQueryOf(st).get("states"), "1,3");
    } finally {
      await st.stop();
    }
  });

  await t.step("--state побеждает env", async () => {
    const st = stand({ env: { KITEN_LS_STATES: "1,3" } });
    try {
      await output(kitenLsCommand, ["--state", "done"], st.io);
      assertEquals(cardsQueryOf(st).get("states"), "3");
    } finally {
      await st.stop();
    }
  });
});

Deno.test("ls: свод осей space/board/lane/column — env целым, CLI резолвом REF по кэшу", async (t) => {
  await t.step("env-целые уходят как id без REF-резолва", async () => {
    const st = stand({
      env: {
        KITEN_LS_SPACE_ID: "3001",
        KITEN_LS_BOARD_ID: "4001",
        KITEN_LS_LANE_ID: "5001",
        KITEN_LS_COLUMN_ID: "6001",
      },
    });
    try {
      await output(kitenLsCommand, [], st.io);
      const q = cardsQueryOf(st);
      assertEquals(q.get("space_id"), "3001");
      assertEquals(q.get("board_id"), "4001");
      assertEquals(q.get("lane_id"), "5001");
      assertEquals(q.get("column_id"), "6001");
    } finally {
      await st.stop();
    }
  });

  await t.step("--board резолвится по кэшу и задаёт скоуп --lane", async () => {
    const st = stand();
    try {
      seedBoard(st, { id: 4002, spaceId: 3001, title: "Доска поддержки" });
      seedLane(st, { id: 5010, boardId: 4002, title: "Дорожка А" });
      // Чужая доска с той же дорожкой: без скоупа резолв стал бы
      // неоднозначным.
      seedLane(st, { id: 5099, boardId: 9999, title: "Дорожка А" });
      await output(kitenLsCommand, [
        "--board",
        "Доска поддержки",
        "--lane",
        "Дорожка А",
      ], st.io);
      const q = cardsQueryOf(st);
      assertEquals(q.get("board_id"), "4002");
      assertEquals(q.get("lane_id"), "5010");
    } finally {
      await st.stop();
    }
  });

  await t.step("--board побеждает KITEN_LS_BOARD_ID", async () => {
    const st = stand({ env: { KITEN_LS_BOARD_ID: "4099" } });
    try {
      seedBoard(st, { id: 4002, spaceId: 3001, title: "Доска" });
      await output(kitenLsCommand, ["--board", "4002"], st.io);
      assertEquals(cardsQueryOf(st).get("board_id"), "4002");
    } finally {
      await st.stop();
    }
  });
});

Deno.test("ls: глобальный режим отключает env-оси целиком, включая доску по умолчанию", async () => {
  const st = stand({
    env: {
      KITEN_LS_CONDITION: "2",
      KITEN_LS_STATES: "1",
      KITEN_LS_SPACE_ID: "3001",
      KITEN_LS_BOARD_ID: "4001",
      KITEN_LS_LANE_ID: "5001",
      KITEN_LS_COLUMN_ID: "6001",
    },
  });
  try {
    await output(kitenLsCommand, ["--date-from", "2026-08-01"], st.io);
    const q = cardsQueryOf(st);
    assertEquals(q.has("condition"), false);
    assertEquals(q.has("states"), false);
    assertEquals(q.has("space_id"), false);
    assertEquals(q.has("board_id"), false);
    assertEquals(q.has("lane_id"), false);
    assertEquals(q.has("column_id"), false);
    assertEquals(q.get("updated_after"), "2026-08-01T00:00:00Z");
  } finally {
    await st.stop();
  }
});

Deno.test("ls: --archived в глобальном режиме всё равно даёт condition=2", async () => {
  const st = stand();
  try {
    await output(kitenLsCommand, [
      "--date-from",
      "2026-08-01",
      "--archived",
    ], st.io);
    assertEquals(cardsQueryOf(st).get("condition"), "2");
  } finally {
    await st.stop();
  }
});

Deno.test("ls: без дат env-оси применяются как обычно", async () => {
  const st = stand({ env: { KITEN_LS_SPACE_ID: "3001" } });
  try {
    await output(kitenLsCommand, [], st.io);
    assertEquals(cardsQueryOf(st).get("space_id"), "3001");
  } finally {
    await st.stop();
  }
});

Deno.test("ls: границы дат инклюзивны — T00:00:00Z / T23:59:59Z", async (t) => {
  await t.step("--date-from → updated_after", async () => {
    const st = stand();
    try {
      await output(kitenLsCommand, ["--date-from", "2026-07-01"], st.io);
      assertEquals(
        cardsQueryOf(st).get("updated_after"),
        "2026-07-01T00:00:00Z",
      );
    } finally {
      await st.stop();
    }
  });

  await t.step("--date-to → updated_before", async () => {
    const st = stand();
    try {
      await output(kitenLsCommand, ["--date-to", "2026-07-15"], st.io);
      assertEquals(
        cardsQueryOf(st).get("updated_before"),
        "2026-07-15T23:59:59Z",
      );
    } finally {
      await st.stop();
    }
  });

  await t.step(
    "--date_from/--date_to — принятые написания с подчёркиванием",
    async () => {
      const st = stand();
      try {
        await output(kitenLsCommand, [
          "--date_from",
          "2026-07-01",
          "--date_to",
          "2026-07-15",
        ], st.io);
        const q = cardsQueryOf(st);
        assertEquals(q.get("updated_after"), "2026-07-01T00:00:00Z");
        assertEquals(q.get("updated_before"), "2026-07-15T23:59:59Z");
      } finally {
        await st.stop();
      }
    },
  );
});

Deno.test("ls: --format — нумерация с 1, неизвестный плейсхолдер остаётся, скобки в данных не интерпретируются", async () => {
  const st = stand({
    cards: [
      {
        id: 1,
        title: "Карточка {n} с фигурными { скобками",
        state: 1,
        due_date: null,
        updated: null,
        column_id: null,
      },
      {
        id: 2,
        title: "Вторая",
        state: 2,
        due_date: "2026-07-23T00:00:00.000Z",
        updated: null,
        column_id: null,
      },
    ],
  });
  try {
    const text = await output(kitenLsCommand, [
      "--format",
      "{n}. {id} {unknown} {title} due={due}",
    ], st.io);
    assertEquals(
      text,
      "1. 1 {unknown} Карточка {n} с фигурными { скобками due=\n" +
        "2. 2 {unknown} Вторая due=2026-07-23\n",
    );
  } finally {
    await st.stop();
  }
});

Deno.test("ls: {column}/{column_mapped} — кэш, промах кэша, KITEN_COLUMN_MAP по id и по названию", async (t) => {
  await t.step("название по кэшу, метка карты по названию", async () => {
    const st = stand({
      cards: [{
        id: 1,
        title: "T",
        state: 1,
        due_date: null,
        updated: null,
        column_id: 9101,
      }],
      env: { KITEN_COLUMN_MAP: JSON.stringify({ "Колонка 1": "К1" }) },
    });
    try {
      seedColumn(st, { id: 9101, boardId: 1, title: "Колонка 1" });
      const text = await output(kitenLsCommand, [
        "--format",
        "{column}|{column_mapped}",
      ], st.io);
      assertEquals(text, "Колонка 1|К1\n");
    } finally {
      await st.stop();
    }
  });

  await t.step("ключ-id проверяется раньше ключа-названия", async () => {
    const st = stand({
      cards: [{
        id: 1,
        title: "T",
        state: 1,
        due_date: null,
        updated: null,
        column_id: 9101,
      }],
      env: {
        KITEN_COLUMN_MAP: JSON.stringify({
          "9101": "по id",
          "Колонка 1": "по имени",
        }),
      },
    });
    try {
      seedColumn(st, { id: 9101, boardId: 1, title: "Колонка 1" });
      const text = await output(kitenLsCommand, [
        "--format",
        "{column_mapped}",
      ], st.io);
      assertEquals(text, "по id\n");
    } finally {
      await st.stop();
    }
  });

  await t.step(
    "промах кэша — id числом; колонки нет — пусто; нет в карте — {column}",
    async () => {
      const st = stand({
        cards: [
          {
            id: 1,
            title: "T1",
            state: 1,
            due_date: null,
            updated: null,
            column_id: 7777,
          },
          {
            id: 2,
            title: "T2",
            state: 1,
            due_date: null,
            updated: null,
            column_id: null,
          },
        ],
      });
      try {
        const text = await output(kitenLsCommand, [
          "--format",
          "{id}:{column}:{column_mapped}",
        ], st.io);
        assertEquals(text, "1:7777:7777\n2::\n");
      } finally {
        await st.stop();
      }
    },
  );
});

Deno.test("ls: --only-url экранирует [ и ] в title", async () => {
  const st = stand({
    cards: [{
      id: 1,
      title: "Баг [важно] в [модуле]",
      state: 1,
      due_date: null,
      updated: null,
      column_id: null,
    }],
  });
  try {
    const text = await output(kitenLsCommand, ["--only-url"], st.io);
    assertStringIncludes(text, "[Баг \\[важно\\] в \\[модуле\\]](");
  } finally {
    await st.stop();
  }
});

Deno.test("ls: --md экранирует | и заменяет переводы строк пробелом", async () => {
  const st = stand({
    cards: [{
      id: 1,
      title: "Заголовок | с чертой\nи переводом строки",
      state: 1,
      due_date: null,
      updated: null,
      column_id: null,
    }],
  });
  try {
    const text = await output(kitenLsCommand, ["--md"], st.io);
    assertStringIncludes(
      text,
      "Заголовок \\| с чертой и переводом строки",
    );
  } finally {
    await st.stop();
  }
});

Deno.test("ls: отказы ввода — точные тексты спеки", async (t) => {
  await t.step("невалидная дата --date-from", async () => {
    const st = stand();
    try {
      assertEquals(
        await errorText(["--date-from", "2026-13-01"], st.io),
        "mpu kiten ls: --date-from='2026-13-01': ожидается YYYY-MM-DD\n",
      );
    } finally {
      await st.stop();
    }
  });

  await t.step("невалидная дата --date-to", async () => {
    const st = stand();
    try {
      assertEquals(
        await errorText(["--date-to", "не дата"], st.io),
        "mpu kiten ls: --date-to='не дата': ожидается YYYY-MM-DD\n",
      );
    } finally {
      await st.stop();
    }
  });

  await t.step("нечисловая env-ось — с именем переменной", async () => {
    const st = stand({ env: { KITEN_LS_CONDITION: "x" } });
    try {
      assertEquals(
        await errorText([], st.io),
        "mpu kiten ls: KITEN_LS_CONDITION='x': ожидалось целое число\n",
      );
    } finally {
      await st.stop();
    }
  });

  await t.step("неизвестное значение --state", async () => {
    const st = stand();
    try {
      const err = await assertRejects(
        () => kitenLsCommand.invoke(["--state", "wat"], st.io),
        UsageError,
      );
      assertStringIncludes(err.message, "--state");
    } finally {
      await st.stop();
    }
  });

  await t.step("нерезолвящийся REF", async () => {
    const st = stand();
    try {
      const err = await assertRejects(
        () => kitenLsCommand.invoke(["--board", "нет такой"], st.io),
        UsageError,
      );
      assertStringIncludes(err.message, "board 'нет такой' не найден");
    } finally {
      await st.stop();
    }
  });
});

Deno.test("ls: битый KITEN_COLUMN_MAP не роняет команду — предупреждение, карта пустая", async (t) => {
  await t.step("невалидный JSON", async () => {
    const st = stand({
      cards: [{
        id: 1,
        title: "T",
        state: 1,
        due_date: null,
        updated: null,
        column_id: 9101,
      }],
      env: { KITEN_COLUMN_MAP: "{не json" },
    });
    try {
      seedColumn(st, { id: 9101, boardId: 1, title: "Колонка 1" });
      const text = await output(kitenLsCommand, [
        "--format",
        "{column_mapped}",
      ], st.io);
      assertEquals(text, "Колонка 1\n");
      assertEquals(st.warnings.length, 1);
      assertStringIncludes(
        st.warnings[0],
        "mpu kiten ls: некорректный JSON в KITEN_COLUMN_MAP:",
      );
    } finally {
      await st.stop();
    }
  });

  await t.step("не объект", async () => {
    const st = stand({
      cards: [{
        id: 1,
        title: "T",
        state: 1,
        due_date: null,
        updated: null,
        column_id: null,
      }],
      env: { KITEN_COLUMN_MAP: "[1,2,3]" },
    });
    try {
      const text = await output(kitenLsCommand, [
        "--format",
        "{column_mapped}",
      ], st.io);
      assertEquals(text, "\n");
      assertEquals(st.warnings, [
        "mpu kiten ls: KITEN_COLUMN_MAP должен быть JSON-объектом",
      ]);
    } finally {
      await st.stop();
    }
  });
});

Deno.test("ls: ошибка API — exit 1, mpu kiten ls: kaiten error: <текст>", async () => {
  const fake = startFakeKaiten(() => new Response("boom", { status: 500 }));
  const io = ioWithoutCache({}, fake.baseUrl);
  try {
    const text = await errorText([], io, DomainError);
    assertStringIncludes(text, "mpu kiten ls: kaiten error:");
  } finally {
    await fake.stop();
  }
});

Deno.test("ls: таблица по умолчанию — состав колонок, итог, пустая выдача", async (t) => {
  await t.step("непустая выдача — шапка, строки, итог (N cards)", async () => {
    const st = stand({ cards: [GOLDEN_CARDS[0]] });
    try {
      seedColumn(st, { id: 9101, boardId: 4001, title: "Колонка 1" });
      const text = await output(kitenLsCommand, [], st.io);
      const lines = text.trimEnd().split("\n");
      assertStringIncludes(lines[0], "ID");
      assertStringIncludes(lines[0], "STATE");
      assertStringIncludes(lines[0], "COLUMN");
      assertStringIncludes(lines[1], "68000001");
      assertStringIncludes(lines[1], "Колонка 1");
      assertEquals(lines[lines.length - 1], "(1 cards)");
    } finally {
      await st.stop();
    }
  });

  await t.step("пустая выдача — (нет карточек)", async () => {
    const st = stand({ cards: [] });
    try {
      const text = await output(kitenLsCommand, [], st.io);
      assertEquals(text, "(нет карточек)\n");
    } finally {
      await st.stop();
    }
  });
});

Deno.test("ls: пустая выдача --format/--only-url — пустая строка, --md — только шапка", async (t) => {
  await t.step("--format", async () => {
    const st = stand({ cards: [] });
    try {
      const text = await output(kitenLsCommand, ["--format", "{id}"], st.io);
      assertEquals(text, "");
    } finally {
      await st.stop();
    }
  });

  await t.step("--only-url", async () => {
    const st = stand({ cards: [] });
    try {
      const text = await output(kitenLsCommand, ["--only-url"], st.io);
      assertEquals(text, "");
    } finally {
      await st.stop();
    }
  });

  await t.step("--md", async () => {
    const st = stand({ cards: [] });
    try {
      const text = await output(kitenLsCommand, ["--md"], st.io);
      assertEquals(
        text,
        "| ID | STATE | COLUMN | DUE | TITLE | URL |\n" +
          "| --- | --- | --- | --- | --- | --- |\n",
      );
    } finally {
      await st.stop();
    }
  });
});

Deno.test("ls: --format {url} подставляет web-адрес карточки", async () => {
  const st = stand({ cards: [GOLDEN_CARDS[0]] });
  try {
    const text = await output(kitenLsCommand, ["--format", "{url}"], st.io);
    assertEquals(text, `${st.baseUrl}/68000001\n`);
  } finally {
    await st.stop();
  }
});
