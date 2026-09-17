import { assertEquals, assertRejects } from "@std/assert";
import { FakeTime } from "@std/testing/time";
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

async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/telegram-status/${name}`, import.meta.url),
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
  const dir = await Deno.makeTempDir();
  const warnings: string[] = [];
  return {
    io: makeFakeIo({
      envFile: envOf(env),
      openCacheDb: () => openCacheDb(`${dir}/cache.db`),
      progress: (line: string) => void warnings.push(line),
    }),
    warnings,
    db: () => openCacheDb(`${dir}/cache.db`),
    close: () => Deno.remove(dir, { recursive: true }),
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

Deno.test("--dry-run --no-live: пустой журнал — отчёт без записей", async () => {
  using time = new FakeTime(NOW_MS);
  const st = await stand();
  try {
    assertEquals(
      await output(st.io, ["--dry-run", "--no-live"]),
      await golden("status-empty-stdout.txt"),
    );
    assertEquals(st.warnings, []);
    assertEquals(time.now, NOW_MS);
  } finally {
    await st.close();
  }
});

Deno.test("--dry-run --no-live: журнал за сегодня — отчёт с записями", async () => {
  using _time = new FakeTime(NOW_MS);
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
    assertEquals(
      await output(st.io, ["--dry-run", "--no-live"]),
      await golden("status-report-stdout.txt"),
    );
  } finally {
    await st.close();
  }
});

Deno.test("адресат не задан — отказ до сети и до кэш-БД", async () => {
  const err = await assertRejects(
    // Кэш-БД у фейкового порта не открывается вовсе: проверка адресата
    // обязана случиться раньше любого обращения.
    () => command.invoke([], makeFakeIo({})),
    VerbatimUsageError,
  );
  assertEquals(`${err.message}\n`, await golden("err-no-chat-stderr.txt"));
});

Deno.test("--dry-run адресата не требует", async () => {
  using _time = new FakeTime(NOW_MS);
  const st = await stand();
  try {
    assertEquals(
      (await output(st.io, ["--dry-run", "--no-live"])).startsWith("Отчёт"),
      true,
    );
  } finally {
    await st.close();
  }
});

Deno.test("живой опрос без ключа Kaiten: предупреждение, отчёт на журнале", async () => {
  using _time = new FakeTime(NOW_MS);
  const st = await stand();
  try {
    assertEquals(
      await output(st.io, ["--dry-run"]),
      await golden("status-empty-stdout.txt"),
    );
    assertEquals(
      `${st.warnings.join("\n")}\n`,
      "mpu telegram status: live-обогащение пропущено " +
        "(Kaiten: KITEN_API_KEY не задан)\n",
    );
  } finally {
    await st.close();
  }
});

Deno.test("после отправки печатается строка JSON отправки", () => {
  assertEquals(
    command.renderResult(
      {
        text: "Отчёт за сегодня (2026-08-17 МСК):",
        sent: { id: 5000001, chat_id: 100000001, date: null },
      },
      [],
    ),
    '{"id": 5000001, "chat_id": 100000001, "date": null}\n',
  );
});

Deno.test("объявление команды", async (t) => {
  await t.step("путь и класс", () => {
    assertEquals(command.path, ["telegram", "status"]);
    // Подкоманда отправляет сообщение, поэтому класс `rw`.
    assertEquals(command.policy, "rw");
    assertEquals(command.errorName, "telegram status");
  });
  await t.step(
    "живой опрос включён по умолчанию, --no-live его снимает",
    () => {
      assertEquals(command.parseArgs([]), {
        live: true,
        "dry-run": false,
      });
      assertEquals(command.parseArgs(["--no-live", "--dry-run"]), {
        live: false,
        "dry-run": true,
      });
    },
  );
  await t.step("описание укладывается в предел клиента", () => {
    const bytes = new TextEncoder().encode(
      `${telegramStatusCommand.summary}\n\n${telegramStatusCommand.help}`,
    ).length;
    assertEquals(bytes < 2048, true, `описание не влезло: ${bytes} байт`);
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

Deno.test("живой опрос: запросы Kaiten и запись в отчёте", async () => {
  using _time = new FakeTime(NOW_MS);
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
    assertEquals(
      text,
      "Отчёт за сегодня (2026-08-17 МСК):\n\n" +
        `1. [Починить выгрузку остатков](${fake.baseUrl}/70000001) — Готово ✅\n`,
    );
    assertEquals(st.warnings, []);
    const cards = fake.seen.find((req) => req.pathname === "/api/latest/cards");
    assertEquals(
      cards?.search,
      "?member_ids=900001&updated_after=2026-08-16T21%3A00%3A00Z" +
        "&updated_before=2026-08-17T20%3A59%3A59Z&limit=100&offset=0",
    );
    // Мой id спрашивается раньше выборки карточек.
    assertEquals(fake.seen[0].pathname, "/api/latest/users/current");
  } finally {
    await fake.stop();
    await st.close();
  }
});

Deno.test("отказ Kaiten: предупреждение и отчёт на журнале", async () => {
  using _time = new FakeTime(NOW_MS);
  const fake = startFakeKaiten(() =>
    new Response("нет доступа", { status: 401 })
  );
  const st = await stand({
    KITEN_API_KEY: "probe-key",
    KITEN_BASE_URL: fake.baseUrl,
  });
  try {
    assertEquals(
      await output(st.io, ["--dry-run"]),
      await golden("status-empty-stdout.txt"),
    );
    assertEquals(st.warnings.length, 1);
    assertEquals(
      st.warnings[0].startsWith(
        "mpu telegram status: live-обогащение пропущено (Kaiten: kaiten GET",
      ),
      true,
      st.warnings[0],
    );
  } finally {
    await fake.stop();
    await st.close();
  }
});

Deno.test("история карточки недоступна: карточка не в отчёте", async () => {
  using _time = new FakeTime(NOW_MS);
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
    assertEquals(
      await output(st.io, ["--dry-run"]),
      await golden("status-empty-stdout.txt"),
    );
    assertEquals(st.warnings.length, 1);
    assertEquals(
      st.warnings[0].startsWith(
        "mpu telegram status: история карточки 70000003 недоступна (Kaiten:",
      ),
      true,
      st.warnings[0],
    );
  } finally {
    await fake.stop();
    await st.close();
  }
});
