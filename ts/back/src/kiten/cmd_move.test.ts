/**
 * Команды `mpu kiten move`, `ready` и `review`
 * (`docs/specs/kiten-move.md`): порядок отказов ввода, решение о релоге
 * по значениям осей, состав PATCH и строка журнала перемещений.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
import type { CacheDb, Command, CommandIo } from "../command/mod.ts";
import { formatCommandError, UsageError } from "../command/mod.ts";
import { type CapturedRequest, startFakeKaiten } from "../kaiten/testing.ts";
import { openCacheDb } from "../store/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import {
  kitenMoveCommand,
  kitenReadyCommand,
  kitenReviewCommand,
} from "./cmd_move.ts";

const CARD_ID = 70000001;
const BOARD_ID = 4000001;
const CARD_PATH = `/api/latest/cards/${CARD_ID}`;
const COLUMNS_PATH = `/api/latest/boards/${BOARD_ID}/columns`;
const LANES_PATH = `/api/latest/boards/${BOARD_ID}/lanes`;

const READY_ID = 5620663;
const BACKLOG_ID = 5620661;
const TESTING_ID = 5620664;

const COLUMNS = [
  { id: BACKLOG_ID, board_id: BOARD_ID, title: "Бэклог", sort_order: 1 },
  { id: 5620662, board_id: BOARD_ID, title: "В работе", sort_order: 2 },
  { id: READY_ID, board_id: BOARD_ID, title: "Готово", sort_order: 3 },
  {
    id: TESTING_ID,
    board_id: BOARD_ID,
    title: "Готово к тестированию",
    sort_order: 4,
  },
];

const LANES = [
  { id: 6000001, board_id: BOARD_ID, title: "Веб" },
  { id: 6000002, board_id: BOARD_ID, title: "Мобилки" },
];

const SPACES = [
  {
    id: 100,
    title: "Продукт",
    boards: [
      { id: BOARD_ID, space_id: 100, title: "Разработка" },
      { id: 4000002, space_id: 100, title: "Доска поддержки" },
    ],
  },
];

/** Карточка стенда: положение задаётся колонкой. */
function card(columnId: number, columnTitle: string) {
  return {
    id: CARD_ID,
    title: "Карточка стенда",
    board_id: BOARD_ID,
    board: { id: BOARD_ID, title: "Разработка" },
    column_id: columnId,
    column: { id: columnId, title: columnTitle },
    lane: { title: "Веб" },
  };
}

type Reply = (body: string) => Response;

interface Stand {
  readonly io: CommandIo;
  readonly baseUrl: string;
  readonly seen: readonly CapturedRequest[];
  readonly db: () => CacheDb;
  readonly stop: () => Promise<void>;
}

/** Стенд: фейковый Kaiten со справочниками доски и настоящая кэш-БД. */
async function stand(
  cards: readonly Record<string, unknown>[],
  env: Record<string, string> = {},
): Promise<Stand> {
  let read = 0;
  const routes: Record<string, Reply> = {
    [`GET ${CARD_PATH}`]: () =>
      Response.json(cards[Math.min(read++, cards.length - 1)]),
    [`GET ${COLUMNS_PATH}`]: () => Response.json(COLUMNS),
    [`GET ${LANES_PATH}`]: () => Response.json(LANES),
    "GET /api/latest/spaces": () => Response.json(SPACES),
    [`PATCH ${CARD_PATH}`]: () => Response.json({ id: CARD_ID }),
  };
  const fake = await startFakeKaiten((seen) => {
    const last = seen[seen.length - 1];
    const route = routes[`${last.method} ${last.pathname}`];
    return route === undefined
      ? new Response("вызов, которого тест не ждал", { status: 500 })
      : route(last.body);
  });
  const values: Readonly<Record<string, string>> = {
    KITEN_API_KEY: "probe-key",
    KITEN_BASE_URL: fake.baseUrl,
    ...env,
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
    baseUrl: fake.baseUrl,
    seen: fake.seen,
    db: () => openCacheDb(`${dir}/cache.db`),
    stop: async () => {
      await fake.stop();
      rmSync(dir, { recursive: true });
    },
  };
}

async function golden(name: string): Promise<string> {
  return await readFile(
    new URL(`./testdata/kiten-move/${name}`, import.meta.url),
    "utf8",
  );
}

/** Текст, который команда печатает человеку. */
async function output(
  command: Command,
  argv: readonly string[],
  io: CommandIo,
): Promise<string> {
  return command.renderResult(await command.invoke(argv, io), argv);
}

/** Строки журнала перемещений в порядке записи. */
function moveRows(st: Stand): readonly Record<string, unknown>[] {
  using db = st.db();
  db.bootstrap();
  return db.query(
    "SELECT * FROM kaiten_card_moves ORDER BY id",
  ) as unknown as readonly Record<string, unknown>[];
}

/** Тела PATCH в порядке отправки. */
function patches(st: Stand): readonly unknown[] {
  return st.seen
    .filter((req) => req.method === "PATCH")
    .map((req) => JSON.parse(req.body));
}

describe("move без осей — отказ до сети, раньше селектора", () => {
  it("голая команда", async () => {
    const err = await rejected(
      () => kitenMoveCommand.invoke([String(CARD_ID)], makeFakeIo({})),
      UsageError,
    );
    expect(
      `${formatCommandError(kitenMoveCommand.errorName, err)}\n`,
    ).toStrictEqual(await golden("err-no-axis-stderr.txt"));
  });
  it("негодный селектор без осей — отказ про оси", async () => {
    const err = await rejected(
      () => kitenMoveCommand.invoke(["abc"], makeFakeIo({})),
      UsageError,
    );
    expect(err.message).toBe(
      "нужно хотя бы одно из --lane / --column / --board",
    );
  });
});

it("move с осью, но негодным селектором — отказ про селектор", async () => {
  const err = await rejected(
    () =>
      kitenMoveCommand.invoke(["abc", "--column", "Готово"], makeFakeIo({})),
    UsageError,
  );
  expect(
    `${formatCommandError(kitenMoveCommand.errorName, err)}\n`,
  ).toStrictEqual(await golden("err-selector-stderr.txt"));
});

describe("ready --dry-run: намерение без единой мутации", () => {
  it("карточка не в целевой колонке", async () => {
    const st = await stand([card(BACKLOG_ID, "Бэклог")]);
    try {
      expect(
        await output(kitenReadyCommand, [String(CARD_ID), "--dry-run"], st.io),
      ).toStrictEqual(await golden("dry-run-move-stdout.txt"));
      expect(patches(st)).toStrictEqual([]);
      expect(moveRows(st)).toStrictEqual([]);
    } finally {
      await st.stop();
    }
  });
  it("карточка уже в целевой колонке — релог", async () => {
    const st = await stand([card(READY_ID, "Готово")]);
    try {
      expect(
        await output(kitenReadyCommand, [String(CARD_ID), "--dry-run"], st.io),
      ).toStrictEqual(await golden("dry-run-relog-stdout.txt"));
      expect(patches(st)).toStrictEqual([]);
    } finally {
      await st.stop();
    }
  });
  it("подстрока в --column: печатается полное название", async () => {
    const st = await stand([card(BACKLOG_ID, "Бэклог")]);
    try {
      expect(
        await output(
          kitenReadyCommand,
          [String(CARD_ID), "--column", "тестиров", "--dry-run"],
          st.io,
        ),
      ).toStrictEqual(await golden("dry-run-substring-stdout.txt"));
      expect(patches(st)).toStrictEqual([]);
    } finally {
      await st.stop();
    }
  });
});

it("ready: PATCH, свежее чтение и строка журнала", async () => {
  const st = await stand(
    [card(BACKLOG_ID, "Бэклог"), card(READY_ID, "Готово")],
    {},
  );
  try {
    const text = await output(
      kitenReadyCommand,
      [String(CARD_ID), "--note", "MR !999"],
      st.io,
    );
    expect(text).toStrictEqual(
      `ok: Разработка · Бэклог · Веб → Разработка · Готово · Веб · ${st.baseUrl}/${CARD_ID}\n`,
    );
    expect(patches(st)).toStrictEqual([{ column_id: READY_ID }]);
    const rows = moveRows(st);
    expect(rows.length).toBe(1);
    expect(rows[0].card_id).toStrictEqual(CARD_ID);
    expect(rows[0].to_column).toBe("Готово");
    expect(rows[0].from_column).toBe("Бэклог");
    expect(rows[0].board).toBe("Разработка");
    expect(rows[0].lane).toBe("Веб");
    expect(rows[0].note).toBe("MR !999");
    expect(rows[0].url).toStrictEqual(`${st.baseUrl}/${CARD_ID}`);
  } finally {
    await st.stop();
  }
});

it("ready на текущей колонке — релог двумя PATCH", async () => {
  const st = await stand([card(READY_ID, "Готово")]);
  try {
    const text = await output(kitenReadyCommand, [String(CARD_ID)], st.io);
    expect(
      text.endsWith(" (релог) · " + st.baseUrl + "/" + CARD_ID + "\n"),
      text,
    ).toBe(true);
    // Сосед слева от «Готово» — «В работе», затем возврат в цель.
    expect(patches(st)).toStrictEqual([
      { column_id: 5620662 },
      {
        column_id: READY_ID,
      },
    ]);
    expect(moveRows(st).length).toBe(1);
  } finally {
    await st.stop();
  }
});

it("review берёт свою колонку из ключа env-файла", async () => {
  const st = await stand(
    [card(BACKLOG_ID, "Бэклог"), card(5620662, "В работе")],
    {
      KITEN_REVIEW_COLUMN: "В работе",
    },
  );
  try {
    await output(kitenReviewCommand, [String(CARD_ID)], st.io);
    expect(patches(st)).toStrictEqual([{ column_id: 5620662 }]);
  } finally {
    await st.stop();
  }
});

describe("move: в PATCH идут только заданные оси", () => {
  it("дорожка и колонка на текущей доске", async () => {
    const st = await stand([
      card(BACKLOG_ID, "Бэклог"),
      card(READY_ID, "Готово"),
    ]);
    try {
      await output(
        kitenMoveCommand,
        [String(CARD_ID), "--column", "Готово", "--lane", "Мобилки"],
        st.io,
      );
      expect(patches(st)).toStrictEqual([
        { lane_id: 6000002, column_id: READY_ID },
      ]);
    } finally {
      await st.stop();
    }
  });
  it("доска резолвится по названию среди всех пространств", async () => {
    const st = await stand([
      card(BACKLOG_ID, "Бэклог"),
      card(BACKLOG_ID, "Бэклог"),
    ]);
    try {
      await output(
        kitenMoveCommand,
        [String(CARD_ID), "--board", "Доска поддержки"],
        st.io,
      );
      expect(patches(st)).toStrictEqual([{ board_id: 4000002 }]);
    } finally {
      await st.stop();
    }
  });
});

it("move --column с текущей колонкой — релог", async () => {
  const st = await stand([card(READY_ID, "Готово")]);
  try {
    const text = await output(
      kitenMoveCommand,
      [String(CARD_ID), "--column", "Готово"],
      st.io,
    );
    expect(text.includes(" (релог) · "), text).toBe(true);
    expect(patches(st)).toStrictEqual([
      { column_id: 5620662 },
      {
        column_id: READY_ID,
      },
    ]);
  } finally {
    await st.stop();
  }
});

it("нерезолвящийся REF — отказ ввода без мутаций", async () => {
  const st = await stand([card(BACKLOG_ID, "Бэклог")]);
  try {
    const err = await rejected(
      () =>
        kitenMoveCommand.invoke([String(CARD_ID), "--column", "Архив"], st.io),
      UsageError,
    );
    expect(err.message).toBe(
      "column 'Архив' не найден — см. `mpu kiten columns`",
    );
    expect(patches(st)).toStrictEqual([]);
  } finally {
    await st.stop();
  }
});

it("релог не запрашивает колонки доски второй раз", async () => {
  const st = await stand([card(READY_ID, "Готово")]);
  try {
    await output(kitenReadyCommand, [String(CARD_ID)], st.io);
    expect(st.seen.filter((req) => req.pathname === COLUMNS_PATH).length).toBe(
      1,
    );
  } finally {
    await st.stop();
  }
});

it("релог возвращает карточку одной колонкой, без прочих осей", async () => {
  const st = await stand([card(READY_ID, "Готово")]);
  try {
    await output(
      kitenMoveCommand,
      [String(CARD_ID), "--column", "Готово", "--lane", "Веб"],
      st.io,
    );
    expect(patches(st)).toStrictEqual([
      { column_id: 5620662 },
      {
        column_id: READY_ID,
      },
    ]);
  } finally {
    await st.stop();
  }
});

describe("объявление команд", () => {
  const commands: readonly [Command, string][] = [
    [kitenMoveCommand, "kiten move"],
    [kitenReadyCommand, "kiten ready"],
    [kitenReviewCommand, "kiten review"],
  ];
  for (const [command, name] of commands) {
    it(name, () => {
      expect(command.path).toStrictEqual(name.split(" "));
      // Все три мутируют карточку, поэтому класс `rw`.
      expect(command.policy).toBe("rw");
      expect(command.errorName).toStrictEqual(name);
      const bytes = new TextEncoder().encode(
        `${command.summary}\n\n${command.help}`,
      ).length;
      expect(bytes < 2048, `описание не влезло: ${bytes} байт`).toBe(true);
    });
  }
});
