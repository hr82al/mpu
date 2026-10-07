/**
 * `mpu kiten ls` (`docs/specs/kiten-ls.md`): свод фильтров по осям
 * CLI-флаг → env → дефолт, глобальный режим дат и четыре машиночитаемых
 * вида вывода поверх таблицы по умолчанию.
 *
 * Вход тестов — фейковый Kaiten на петле (`../kaiten/testing.ts`) и
 * настоящая кэш-БД во временном каталоге: резолв `REF` и подпись колонки
 * читают её саму, а не мок. Вызов идёт от argv, как из точки входа.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
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
async function stand(
  options: {
    readonly cards?: readonly Record<string, unknown>[];
    readonly user?: Record<string, unknown>;
    readonly env?: Record<string, string>;
  } = {},
): Promise<Stand> {
  const cards = options.cards ?? [];
  const user = options.user ?? USER;
  const fake = await startFakeKaiten((seen) => {
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
  const dir = mkdtempSync(join(tmpdir(), "mpu-"));
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
      rmSync(dir, { recursive: true });
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
  return readFile(
    new URL(`testdata/kiten-ls/${name}`, import.meta.url),
    "utf8",
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
  const err = await rejected(() => kitenLsCommand.invoke(argv, io), kind);
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

it("ls: --json совпадает с голденом байт-в-байт (глобальный режим)", async () => {
  const st = await stand({ cards: GOLDEN_CARDS });
  try {
    const text = await output(
      kitenLsCommand,
      ["--date-from", "2026-07-01", "--date-to", "2026-08-19", "--json"],
      st.io,
    );
    expect(text).toStrictEqual(await expected("ls-global.json", st.baseUrl));
  } finally {
    await st.stop();
  }
});

it("ls: --md совпадает с голденом байт-в-байт (глобальный режим)", async () => {
  const st = await stand({ cards: GOLDEN_CARDS });
  try {
    seedColumn(st, { id: 9101, boardId: 4001, title: "Колонка 1" });
    seedColumn(st, { id: 9102, boardId: 4001, title: "Колонка 2" });
    const text = await output(
      kitenLsCommand,
      ["--date-from", "2026-07-01", "--date-to", "2026-08-19", "--md"],
      st.io,
    );
    expect(text).toStrictEqual(await expected("ls-global.md", st.baseUrl));
  } finally {
    await st.stop();
  }
});

it("ls: --json не несёт колонку, доску и дорожку — ровно шесть ключей", async () => {
  const st = await stand({ cards: GOLDEN_CARDS });
  try {
    seedColumn(st, { id: 9101, boardId: 4001, title: "Колонка 1" });
    const text = await output(kitenLsCommand, ["--json"], st.io);
    const rows = JSON.parse(text) as readonly Record<string, unknown>[];
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toStrictEqual([
        "due_date",
        "id",
        "state",
        "title",
        "updated",
        "url",
      ]);
    }
  } finally {
    await st.stop();
  }
});

it("ls: --json не трогает кэш вовсе, если REF не задан", async () => {
  const fake = await startFakeKaiten((seen) => {
    const last = seen[seen.length - 1];
    if (last.pathname === USER_PATH) return Response.json(USER);
    if (last.pathname === CARDS_PATH) return Response.json(GOLDEN_CARDS);
    return new Response("путь, которого тест не ждал", { status: 500 });
  });
  const io = ioWithoutCache({}, fake.baseUrl);
  try {
    const text = await output(kitenLsCommand, ["--json"], io);
    expect((JSON.parse(text) as unknown[]).length).toBe(3);
  } finally {
    await fake.stop();
  }
});

describe("ls: приоритет видов вывода — json > format > only-url > md", () => {
  it("--json побеждает остальные флаги вида", async () => {
    const st = await stand({ cards: [GOLDEN_CARDS[0]] });
    try {
      const text = await output(
        kitenLsCommand,
        ["--json", "--format", "{id}", "--only-url", "--md"],
        st.io,
      );
      expect(text.startsWith("[")).toBe(true);
    } finally {
      await st.stop();
    }
  });

  it("--format побеждает --only-url и --md", async () => {
    const st = await stand({ cards: [GOLDEN_CARDS[0]] });
    try {
      const text = await output(
        kitenLsCommand,
        ["--format", "F{id}", "--only-url", "--md"],
        st.io,
      );
      expect(text).toBe("F68000001\n");
    } finally {
      await st.stop();
    }
  });

  it("--only-url побеждает --md", async () => {
    const st = await stand({ cards: [GOLDEN_CARDS[0]] });
    try {
      const text = await output(kitenLsCommand, ["--only-url", "--md"], st.io);
      expect(text).toContain("](");
      expect(text.includes("| ID |")).toBe(false);
    } finally {
      await st.stop();
    }
  });
});

describe("ls: свод оси condition — CLI > env > дефолт, --archived побеждает всегда", () => {
  it("дефолт condition=1 без флагов и env", async () => {
    const st = await stand();
    try {
      await output(kitenLsCommand, [], st.io);
      expect(cardsQueryOf(st).get("condition")).toBe("1");
    } finally {
      await st.stop();
    }
  });

  it("env KITEN_LS_CONDITION побеждает дефолт", async () => {
    const st = await stand({ env: { KITEN_LS_CONDITION: "2" } });
    try {
      await output(kitenLsCommand, [], st.io);
      expect(cardsQueryOf(st).get("condition")).toBe("2");
    } finally {
      await st.stop();
    }
  });

  it("--archived побеждает env", async () => {
    const st = await stand({ env: { KITEN_LS_CONDITION: "1" } });
    try {
      await output(kitenLsCommand, ["--archived"], st.io);
      expect(cardsQueryOf(st).get("condition")).toBe("2");
    } finally {
      await st.stop();
    }
  });
});

describe("ls: свод оси states — --state мапится, env уходит как есть, CLI побеждает", () => {
  it("--state мапится в код сервера", async () => {
    const st = await stand();
    try {
      await output(kitenLsCommand, ["--state", "in-progress"], st.io);
      expect(cardsQueryOf(st).get("states")).toBe("2");
    } finally {
      await st.stop();
    }
  });

  it("env KITEN_LS_STATES уходит дословно", async () => {
    const st = await stand({ env: { KITEN_LS_STATES: "1,3" } });
    try {
      await output(kitenLsCommand, [], st.io);
      expect(cardsQueryOf(st).get("states")).toBe("1,3");
    } finally {
      await st.stop();
    }
  });

  it("--state побеждает env", async () => {
    const st = await stand({ env: { KITEN_LS_STATES: "1,3" } });
    try {
      await output(kitenLsCommand, ["--state", "done"], st.io);
      expect(cardsQueryOf(st).get("states")).toBe("3");
    } finally {
      await st.stop();
    }
  });
});

describe("ls: свод осей space/board/lane/column — env целым, CLI резолвом REF по кэшу", () => {
  it("env-целые уходят как id без REF-резолва", async () => {
    const st = await stand({
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
      expect(q.get("space_id")).toBe("3001");
      expect(q.get("board_id")).toBe("4001");
      expect(q.get("lane_id")).toBe("5001");
      expect(q.get("column_id")).toBe("6001");
    } finally {
      await st.stop();
    }
  });

  it("--board резолвится по кэшу и задаёт скоуп --lane", async () => {
    const st = await stand();
    try {
      seedBoard(st, { id: 4002, spaceId: 3001, title: "Доска поддержки" });
      seedLane(st, { id: 5010, boardId: 4002, title: "Дорожка А" });
      // Чужая доска с той же дорожкой: без скоупа резолв стал бы
      // неоднозначным.
      seedLane(st, { id: 5099, boardId: 9999, title: "Дорожка А" });
      await output(
        kitenLsCommand,
        ["--board", "Доска поддержки", "--lane", "Дорожка А"],
        st.io,
      );
      const q = cardsQueryOf(st);
      expect(q.get("board_id")).toBe("4002");
      expect(q.get("lane_id")).toBe("5010");
    } finally {
      await st.stop();
    }
  });

  it("--board побеждает KITEN_LS_BOARD_ID", async () => {
    const st = await stand({ env: { KITEN_LS_BOARD_ID: "4099" } });
    try {
      seedBoard(st, { id: 4002, spaceId: 3001, title: "Доска" });
      await output(kitenLsCommand, ["--board", "4002"], st.io);
      expect(cardsQueryOf(st).get("board_id")).toBe("4002");
    } finally {
      await st.stop();
    }
  });
});

it("ls: глобальный режим отключает env-оси целиком, включая доску по умолчанию", async () => {
  const st = await stand({
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
    expect(q.has("condition")).toBe(false);
    expect(q.has("states")).toBe(false);
    expect(q.has("space_id")).toBe(false);
    expect(q.has("board_id")).toBe(false);
    expect(q.has("lane_id")).toBe(false);
    expect(q.has("column_id")).toBe(false);
    expect(q.get("updated_after")).toBe("2026-08-01T00:00:00Z");
  } finally {
    await st.stop();
  }
});

it("ls: --archived в глобальном режиме всё равно даёт condition=2", async () => {
  const st = await stand();
  try {
    await output(
      kitenLsCommand,
      ["--date-from", "2026-08-01", "--archived"],
      st.io,
    );
    expect(cardsQueryOf(st).get("condition")).toBe("2");
  } finally {
    await st.stop();
  }
});

it("ls: без дат env-оси применяются как обычно", async () => {
  const st = await stand({ env: { KITEN_LS_SPACE_ID: "3001" } });
  try {
    await output(kitenLsCommand, [], st.io);
    expect(cardsQueryOf(st).get("space_id")).toBe("3001");
  } finally {
    await st.stop();
  }
});

describe("ls: границы дат инклюзивны — T00:00:00Z / T23:59:59Z", () => {
  it("--date-from → updated_after", async () => {
    const st = await stand();
    try {
      await output(kitenLsCommand, ["--date-from", "2026-07-01"], st.io);
      expect(cardsQueryOf(st).get("updated_after")).toBe(
        "2026-07-01T00:00:00Z",
      );
    } finally {
      await st.stop();
    }
  });

  it("--date-to → updated_before", async () => {
    const st = await stand();
    try {
      await output(kitenLsCommand, ["--date-to", "2026-07-15"], st.io);
      expect(cardsQueryOf(st).get("updated_before")).toBe(
        "2026-07-15T23:59:59Z",
      );
    } finally {
      await st.stop();
    }
  });

  it("--date_from/--date_to — принятые написания с подчёркиванием", async () => {
    const st = await stand();
    try {
      await output(
        kitenLsCommand,
        ["--date_from", "2026-07-01", "--date_to", "2026-07-15"],
        st.io,
      );
      const q = cardsQueryOf(st);
      expect(q.get("updated_after")).toBe("2026-07-01T00:00:00Z");
      expect(q.get("updated_before")).toBe("2026-07-15T23:59:59Z");
    } finally {
      await st.stop();
    }
  });
});

it("ls: --format — нумерация с 1, неизвестный плейсхолдер остаётся, скобки в данных не интерпретируются", async () => {
  const st = await stand({
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
    const text = await output(
      kitenLsCommand,
      ["--format", "{n}. {id} {unknown} {title} due={due}"],
      st.io,
    );
    expect(text).toStrictEqual(
      "1. 1 {unknown} Карточка {n} с фигурными { скобками due=\n" +
        "2. 2 {unknown} Вторая due=2026-07-23\n",
    );
  } finally {
    await st.stop();
  }
});

describe("ls: {column}/{column_mapped} — кэш, промах кэша, KITEN_COLUMN_MAP по id и по названию", () => {
  it("название по кэшу, метка карты по названию", async () => {
    const st = await stand({
      cards: [
        {
          id: 1,
          title: "T",
          state: 1,
          due_date: null,
          updated: null,
          column_id: 9101,
        },
      ],
      env: { KITEN_COLUMN_MAP: JSON.stringify({ "Колонка 1": "К1" }) },
    });
    try {
      seedColumn(st, { id: 9101, boardId: 1, title: "Колонка 1" });
      const text = await output(
        kitenLsCommand,
        ["--format", "{column}|{column_mapped}"],
        st.io,
      );
      expect(text).toBe("Колонка 1|К1\n");
    } finally {
      await st.stop();
    }
  });

  it("ключ-id проверяется раньше ключа-названия", async () => {
    const st = await stand({
      cards: [
        {
          id: 1,
          title: "T",
          state: 1,
          due_date: null,
          updated: null,
          column_id: 9101,
        },
      ],
      env: {
        KITEN_COLUMN_MAP: JSON.stringify({
          "9101": "по id",
          "Колонка 1": "по имени",
        }),
      },
    });
    try {
      seedColumn(st, { id: 9101, boardId: 1, title: "Колонка 1" });
      const text = await output(
        kitenLsCommand,
        ["--format", "{column_mapped}"],
        st.io,
      );
      expect(text).toBe("по id\n");
    } finally {
      await st.stop();
    }
  });

  it("промах кэша — id числом; колонки нет — пусто; нет в карте — {column}", async () => {
    const st = await stand({
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
      const text = await output(
        kitenLsCommand,
        ["--format", "{id}:{column}:{column_mapped}"],
        st.io,
      );
      expect(text).toBe("1:7777:7777\n2::\n");
    } finally {
      await st.stop();
    }
  });
});

it("ls: --only-url экранирует [ и ] в title", async () => {
  const st = await stand({
    cards: [
      {
        id: 1,
        title: "Баг [важно] в [модуле]",
        state: 1,
        due_date: null,
        updated: null,
        column_id: null,
      },
    ],
  });
  try {
    const text = await output(kitenLsCommand, ["--only-url"], st.io);
    expect(text).toContain("[Баг \\[важно\\] в \\[модуле\\]](");
  } finally {
    await st.stop();
  }
});

it("ls: --md экранирует | и заменяет переводы строк пробелом", async () => {
  const st = await stand({
    cards: [
      {
        id: 1,
        title: "Заголовок | с чертой\nи переводом строки",
        state: 1,
        due_date: null,
        updated: null,
        column_id: null,
      },
    ],
  });
  try {
    const text = await output(kitenLsCommand, ["--md"], st.io);
    expect(text).toContain("Заголовок \\| с чертой и переводом строки");
  } finally {
    await st.stop();
  }
});

describe("ls: отказы ввода — точные тексты спеки", () => {
  it("невалидная дата --date-from", async () => {
    const st = await stand();
    try {
      expect(await errorText(["--date-from", "2026-13-01"], st.io)).toBe(
        "mpu kiten ls: --date-from='2026-13-01': ожидается YYYY-MM-DD\n",
      );
    } finally {
      await st.stop();
    }
  });

  it("невалидная дата --date-to", async () => {
    const st = await stand();
    try {
      expect(await errorText(["--date-to", "не дата"], st.io)).toBe(
        "mpu kiten ls: --date-to='не дата': ожидается YYYY-MM-DD\n",
      );
    } finally {
      await st.stop();
    }
  });

  it("нечисловая env-ось — с именем переменной", async () => {
    const st = await stand({ env: { KITEN_LS_CONDITION: "x" } });
    try {
      expect(await errorText([], st.io)).toBe(
        "mpu kiten ls: KITEN_LS_CONDITION='x': ожидалось целое число\n",
      );
    } finally {
      await st.stop();
    }
  });

  it("неизвестное значение --state", async () => {
    const st = await stand();
    try {
      const err = await rejected(
        () => kitenLsCommand.invoke(["--state", "wat"], st.io),
        UsageError,
      );
      expect(err.message).toContain("state:");
    } finally {
      await st.stop();
    }
  });

  it("нерезолвящийся REF", async () => {
    const st = await stand();
    try {
      const err = await rejected(
        () => kitenLsCommand.invoke(["--board", "нет такой"], st.io),
        UsageError,
      );
      expect(err.message).toContain("board 'нет такой' не найден");
    } finally {
      await st.stop();
    }
  });
});

describe("ls: битый KITEN_COLUMN_MAP не роняет команду — предупреждение, карта пустая", () => {
  it("невалидный JSON", async () => {
    const st = await stand({
      cards: [
        {
          id: 1,
          title: "T",
          state: 1,
          due_date: null,
          updated: null,
          column_id: 9101,
        },
      ],
      env: { KITEN_COLUMN_MAP: "{не json" },
    });
    try {
      seedColumn(st, { id: 9101, boardId: 1, title: "Колонка 1" });
      const text = await output(
        kitenLsCommand,
        ["--format", "{column_mapped}"],
        st.io,
      );
      expect(text).toBe("Колонка 1\n");
      expect(st.warnings.length).toBe(1);
      expect(st.warnings[0]).toContain(
        "mpu kiten ls: некорректный JSON в KITEN_COLUMN_MAP:",
      );
    } finally {
      await st.stop();
    }
  });

  it("не объект", async () => {
    const st = await stand({
      cards: [
        {
          id: 1,
          title: "T",
          state: 1,
          due_date: null,
          updated: null,
          column_id: null,
        },
      ],
      env: { KITEN_COLUMN_MAP: "[1,2,3]" },
    });
    try {
      const text = await output(
        kitenLsCommand,
        ["--format", "{column_mapped}"],
        st.io,
      );
      expect(text).toBe("\n");
      expect(st.warnings).toStrictEqual([
        "mpu kiten ls: KITEN_COLUMN_MAP должен быть JSON-объектом",
      ]);
    } finally {
      await st.stop();
    }
  });
});

it("ls: ошибка API — exit 1, mpu kiten ls: kaiten error: <текст>", async () => {
  const fake = await startFakeKaiten(
    () => new Response("boom", { status: 500 }),
  );
  const io = ioWithoutCache({}, fake.baseUrl);
  try {
    const text = await errorText([], io, DomainError);
    expect(text).toContain("mpu kiten ls: kaiten error:");
  } finally {
    await fake.stop();
  }
});

describe("ls: таблица по умолчанию — состав колонок, итог, пустая выдача", () => {
  it("непустая выдача — шапка, строки, итог (N cards)", async () => {
    const st = await stand({ cards: [GOLDEN_CARDS[0]] });
    try {
      seedColumn(st, { id: 9101, boardId: 4001, title: "Колонка 1" });
      const text = await output(kitenLsCommand, [], st.io);
      const lines = text.trimEnd().split("\n");
      expect(lines[0]).toContain("ID");
      expect(lines[0]).toContain("STATE");
      expect(lines[0]).toContain("COLUMN");
      expect(lines[1]).toContain("68000001");
      expect(lines[1]).toContain("Колонка 1");
      expect(lines[lines.length - 1]).toBe("(1 cards)");
    } finally {
      await st.stop();
    }
  });

  it("пустая выдача — (нет карточек)", async () => {
    const st = await stand({ cards: [] });
    try {
      const text = await output(kitenLsCommand, [], st.io);
      expect(text).toBe("(нет карточек)\n");
    } finally {
      await st.stop();
    }
  });
});

describe("ls: пустая выдача --format/--only-url — пустая строка, --md — только шапка", () => {
  it("--format", async () => {
    const st = await stand({ cards: [] });
    try {
      const text = await output(kitenLsCommand, ["--format", "{id}"], st.io);
      expect(text).toBe("");
    } finally {
      await st.stop();
    }
  });

  it("--only-url", async () => {
    const st = await stand({ cards: [] });
    try {
      const text = await output(kitenLsCommand, ["--only-url"], st.io);
      expect(text).toBe("");
    } finally {
      await st.stop();
    }
  });

  it("--md", async () => {
    const st = await stand({ cards: [] });
    try {
      const text = await output(kitenLsCommand, ["--md"], st.io);
      expect(text).toStrictEqual(
        "| ID | STATE | COLUMN | DUE | TITLE | URL |\n" +
          "| --- | --- | --- | --- | --- | --- |\n",
      );
    } finally {
      await st.stop();
    }
  });
});

it("ls: --format {url} подставляет web-адрес карточки", async () => {
  const st = await stand({ cards: [GOLDEN_CARDS[0]] });
  try {
    const text = await output(kitenLsCommand, ["--format", "{url}"], st.io);
    expect(text).toStrictEqual(`${st.baseUrl}/68000001\n`);
  } finally {
    await st.stop();
  }
});
