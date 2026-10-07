import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import type { CacheDb, Command, CommandIo } from "../command/mod.ts";
import { VerbatimUsageError } from "../command/mod.ts";
import { startFakeKaiten } from "../kaiten/testing.ts";
import { recordMove } from "../kiten/card_move.ts";
import { openCacheDb } from "../store/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { telegramStatusCommand } from "./cmd_status.ts";

const command: Command = telegramStatusCommand;

/** 2026-08-17 10:00 МСК — день голденов; часы подставляются, не берутся. */
const NOW_MS = Date.parse("2026-08-17T07:00:00.000Z");

/**
 * Что подменяют часы — ровно то же, что прежний `FakeTime`: дата и
 * таймеры, без `setImmediate` (у Vitest он в подменах по умолчанию).
 */
const FAKED: Array<
  "Date" | "setTimeout" | "clearTimeout" | "setInterval" | "clearInterval"
> = [
  "Date",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
];

// `using FakeTime` снимал подмену в конце теста.
afterEach(() => {
  vi.useRealTimers();
});

async function golden(name: string): Promise<string> {
  return await readFile(
    new URL(`./testdata/telegram-status/${name}`, import.meta.url),
    "utf8",
  );
}

/** Стенд: кэш-БД во временном каталоге и env-файл под неё. */
interface Stand {
  readonly io: CommandIo;
  readonly warnings: readonly string[];
  readonly db: () => CacheDb;
  readonly close: () => Promise<void>;
}

async function stand(env: Record<string, string> = {}): Promise<Stand> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  const warnings: string[] = [];
  return {
    io: makeFakeIo({
      envFile: envOf(env),
      openCacheDb: () => openCacheDb(`${dir}/cache.db`),
      progress: (line: string) => void warnings.push(line),
    }),
    warnings,
    db: () => openCacheDb(`${dir}/cache.db`),
    close: () => rm(dir, { recursive: true }),
  };
}

/** Строка журнала: только то, что читает отчёт. */
function logged(
  cardId: number,
  title: string,
  toColumn: string,
  movedAt: number,
  url = "",
) {
  return {
    cardId,
    title,
    url,
    toColumn,
    fromColumn: null,
    lane: null,
    board: null,
    note: "",
    movedAt,
  };
}

it("--dry-run --no-live: пустой журнал — отчёт без записей", async () => {
  vi.useFakeTimers({ now: NOW_MS, toFake: FAKED });
  const st = await stand();
  try {
    expect(await output(st.io, ["--dry-run", "--no-live"])).toStrictEqual(
      await golden("status-empty-stdout.txt"),
    );
    expect(st.warnings).toStrictEqual([]);
    expect(Date.now()).toBe(NOW_MS);
  } finally {
    await st.close();
  }
});

it("--dry-run --no-live: журнал за сегодня — отчёт с записями", async () => {
  vi.useFakeTimers({ now: NOW_MS, toFake: FAKED });
  const st = await stand({ KITEN_BASE_URL: "https://kaiten.example/" });
  try {
    {
      using db = st.db();
      recordMove(
        db,
        logged(
          70000001,
          "Починить выгрузку остатков",
          "Готово",
          Math.trunc(Date.parse("2026-08-17T06:40:00Z") / 1000),
        ),
      );
      recordMove(
        db,
        logged(
          70000002,
          "Отчёт по марже [черновик]",
          "Код-ревью",
          Math.trunc(Date.parse("2026-08-17T06:20:00Z") / 1000),
        ),
      );
      recordMove(
        db,
        logged(
          70000003,
          "",
          "4210",
          Math.trunc(Date.parse("2026-08-17T06:00:00Z") / 1000),
        ),
      );
      // Вчерашняя запись в сегодняшний отчёт не идёт.
      recordMove(
        db,
        logged(
          70000004,
          "вчерашняя",
          "Готово",
          Math.trunc(Date.parse("2026-08-16T06:00:00Z") / 1000),
        ),
      );
    }
    expect(await output(st.io, ["--dry-run", "--no-live"])).toStrictEqual(
      await golden("status-report-stdout.txt"),
    );
  } finally {
    await st.close();
  }
});

it("адресат не задан — отказ до сети и до кэш-БД", async () => {
  // Кэш-БД у фейкового порта не открывается вовсе: проверка адресата
  // обязана случиться раньше любого обращения.
  const err = await command.invoke([], makeFakeIo({})).then(
    () => null,
    (e: unknown) => e,
  );
  assert(
    err instanceof VerbatimUsageError,
    "ожидался отказ VerbatimUsageError",
  );
  expect(`${err.message}\n`).toStrictEqual(
    await golden("err-no-chat-stderr.txt"),
  );
});

it("--dry-run адресата не требует", async () => {
  vi.useFakeTimers({ now: NOW_MS, toFake: FAKED });
  const st = await stand();
  try {
    expect(
      (await output(st.io, ["--dry-run", "--no-live"])).startsWith("Отчёт"),
    ).toBe(true);
  } finally {
    await st.close();
  }
});

it("живой опрос без ключа Kaiten: предупреждение, отчёт на журнале", async () => {
  vi.useFakeTimers({ now: NOW_MS, toFake: FAKED });
  const st = await stand();
  try {
    expect(await output(st.io, ["--dry-run"])).toStrictEqual(
      await golden("status-empty-stdout.txt"),
    );
    expect(`${st.warnings.join("\n")}\n`).toStrictEqual(
      "mpu telegram status: live-обогащение пропущено " +
        "(Kaiten: KITEN_API_KEY не задан)\n",
    );
  } finally {
    await st.close();
  }
});

it("после отправки печатается строка JSON отправки", () => {
  expect(command.renderResult(
    {
      text: "Отчёт за сегодня (2026-08-17 МСК):",
      sent: { id: 5000001, chat_id: 100000001, date: null },
    },
    [],
  )).toBe('{"id": 5000001, "chat_id": 100000001, "date": null}\n');
});

describe("объявление команды", () => {
  it("путь и класс", () => {
    expect(command.path).toStrictEqual(["telegram", "status"]);
    // Подкоманда отправляет сообщение, поэтому класс `rw`.
    expect(command.policy).toBe("rw");
    expect(command.errorName).toBe("telegram status");
  });
  it("живой опрос включён по умолчанию, --no-live его снимает", () => {
    expect(command.parseArgs([])).toStrictEqual({
      live: true,
      "dry-run": false,
    });
    expect(command.parseArgs(["--no-live", "--dry-run"])).toStrictEqual({
      live: false,
      "dry-run": true,
    });
  });
  it("описание укладывается в предел клиента", () => {
    const bytes = new TextEncoder().encode(
      `${telegramStatusCommand.summary}\n\n${telegramStatusCommand.help}`,
    ).length;
    expect(bytes < 2048, `описание не влезло: ${bytes} байт`).toBe(true);
  });
});

/** Текст, который команда печатает человеку. */
async function output(io: CommandIo, argv: readonly string[]) {
  const result = await command.invoke(argv, io);
  return command.renderResult(result, argv);
}

/** Env-файл стенда: команда только читает ключи, запись ей не нужна. */
function envOf(env: Record<string, string>): CommandIo["envFile"] {
  return {
    ...makeFakeIo({}).envFile,
    get: (name: string) => env[name],
    values: () => ({ ...env }),
  };
}

it("живой опрос: запросы Kaiten и запись в отчёте", async () => {
  vi.useFakeTimers({ now: NOW_MS, toFake: FAKED });
  const fake = startFakeKaiten((seen) => {
    const last = seen[seen.length - 1];
    const body: unknown = {
      "/api/latest/users/current": { id: 900001, full_name: "Я" },
      "/api/latest/cards": [
        {
          id: 70000001,
          title: "Починить выгрузку остатков",
          board_id: 4000001,
        },
      ],
      "/api/latest/cards/70000001/location-history": [
        {
          card_id: 70000001,
          column_id: 5000001,
          author_id: 900001,
          changed: "2026-08-17T06:40:00Z",
        },
        // Чужая смена в отчёт не идёт, даже если она позже моей.
        {
          card_id: 70000001,
          column_id: 5000002,
          author_id: 900002,
          changed: "2026-08-17T06:50:00Z",
        },
      ],
      "/api/latest/boards/4000001/columns": [
        { id: 5000001, board_id: 4000001, title: "Готово" },
      ],
    }[last.pathname] ?? { error: last.pathname };
    return Response.json(body);
  });
  const st = await stand({
    KITEN_API_KEY: "probe-key",
    KITEN_BASE_URL: fake.baseUrl,
  });
  try {
    const text = await output(st.io, ["--dry-run"]);
    expect(text).toStrictEqual(
      "Отчёт за сегодня (2026-08-17 МСК):\n\n" +
        `1. [Починить выгрузку остатков](${fake.baseUrl}/70000001) — Готово ✅\n`,
    );
    expect(st.warnings).toStrictEqual([]);
    const cards = fake.seen.find((req) => req.pathname === "/api/latest/cards");
    expect(cards?.search).toStrictEqual(
      "?member_ids=900001&updated_after=2026-08-16T21%3A00%3A00Z" +
        "&updated_before=2026-08-17T20%3A59%3A59Z&limit=100&offset=0",
    );
    // Мой id спрашивается раньше выборки карточек.
    expect(fake.seen[0].pathname).toBe("/api/latest/users/current");
  } finally {
    await fake.stop();
    await st.close();
  }
});

it("отказ Kaiten: предупреждение и отчёт на журнале", async () => {
  vi.useFakeTimers({ now: NOW_MS, toFake: FAKED });
  const fake = startFakeKaiten(() =>
    new Response("нет доступа", { status: 401 })
  );
  const st = await stand({
    KITEN_API_KEY: "probe-key",
    KITEN_BASE_URL: fake.baseUrl,
  });
  try {
    expect(await output(st.io, ["--dry-run"])).toStrictEqual(
      await golden("status-empty-stdout.txt"),
    );
    expect(st.warnings.length).toBe(1);
    expect(
      st.warnings[0].startsWith(
        "mpu telegram status: live-обогащение пропущено (Kaiten: kaiten GET",
      ),
      st.warnings[0],
    ).toBe(true);
  } finally {
    await fake.stop();
    await st.close();
  }
});

it("история карточки недоступна: карточка не в отчёте", async () => {
  vi.useFakeTimers({ now: NOW_MS, toFake: FAKED });
  const fake = startFakeKaiten((seen) => {
    const last = seen[seen.length - 1];
    if (last.pathname === "/api/latest/users/current") {
      return Response.json({ id: 900001 });
    }
    if (last.pathname === "/api/latest/cards") {
      return Response.json([{ id: 70000003, title: "к", board_id: 4000001 }]);
    }
    return new Response("нет доступа", { status: 403 });
  });
  const st = await stand({
    KITEN_API_KEY: "probe-key",
    KITEN_BASE_URL: fake.baseUrl,
  });
  try {
    expect(await output(st.io, ["--dry-run"])).toStrictEqual(
      await golden("status-empty-stdout.txt"),
    );
    expect(st.warnings.length).toBe(1);
    expect(
      st.warnings[0].startsWith(
        "mpu telegram status: история карточки 70000003 недоступна (Kaiten:",
      ),
      st.warnings[0],
    ).toBe(true);
  } finally {
    await fake.stop();
    await st.close();
  }
});
