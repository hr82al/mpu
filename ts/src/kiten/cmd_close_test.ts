/**
 * Команда `mpu kiten close` (`docs/specs/kiten-close.md`). Вызов идёт от
 * argv, как из точки входа, а каталог ходит в фейковый Kaiten на петле
 * (`../kaiten/testing.ts`): у оркестратора состав и ПОРЯДОК запросов сам
 * по себе инвариант — неверная колонка не смеет стоить ни одной мутации,
 * а таймер без флага не смеет остановиться.
 *
 * Журнал перемещений проверяется настоящей кэш-БД во временном каталоге:
 * фейк проверял бы форму вызова, а не то, что строка легла в таблицу
 * схемы.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type Command,
  type CommandIo,
  DomainError,
  UsageError,
} from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { type CapturedRequest, startFakeKaiten } from "../kaiten/testing.ts";
import { mskStamp } from "./msk.ts";
import { kitenCloseCommand } from "./mod.ts";

const API_KEY = "proba-kaiten-key-Q3z8Nw";
const CARD_ID = 10000001;
const SELECTOR = String(CARD_ID);
const BOARD_ID = 4000001;
const READY_COLUMN_ID = 5000001;
const CURRENT_COLUMN_ID = 5000002;
const TIMER_ID = 6000001;
const LOG_ID = 7000001;
const COMMENT_ID = 8000001;
const ROLE_ID = 12058;

const CARD_PATH = `/api/latest/cards/${CARD_ID}`;
const COLUMNS_PATH = `/api/latest/boards/${BOARD_ID}/columns`;
const COMMENTS_PATH = `${CARD_PATH}/comments`;
const TIME_LOGS_PATH = `${CARD_PATH}/time-logs`;
const ROLES_PATH = "/api/latest/user-roles";
const TIMER_PATH = `/api/latest/user-timers/${TIMER_ID}`;

/** Адрес карточки в голденах: снят с обезличенного живого прогона. */
const GOLDEN_CARD_URL = `https://kaiten.example.test/${CARD_ID}`;

/** Метка старта таймера в голденах; под стенд подставляется своя. */
const GOLDEN_STAMP = "14.08 19:50 МСК";

/** Ключи полей карточки — таблица `kiten-field.md`. */
const HYPOTHESIS = "id_291984";
const DONE = "id_291985";
const RESULT = "id_291990";

/** Колонки доски: порядок ответа не совпадает с порядком слева направо. */
const COLUMNS = [
  { id: READY_COLUMN_ID, board_id: BOARD_ID, title: "Готово", sort_order: 3 },
  { id: CURRENT_COLUMN_ID, board_id: BOARD_ID, title: "Бэклог", sort_order: 1 },
  { id: 5000003, board_id: BOARD_ID, title: "В работе", sort_order: 2 },
];

/** Таймер карточки, идущий полминуты назад: натёкшее — «1 мин». */
function startedHalfMinuteAgo(): number {
  return Date.now() - 30_000;
}

function rawTimer(startedAtMs: number): Record<string, unknown> {
  return {
    id: TIMER_ID,
    card_id: CARD_ID,
    comment: "разбор жалобы",
    started_at: new Date(startedAtMs).toISOString(),
  };
}

/** Карточка стенда: доска, колонка и дорожка — как в голденах. */
function rawCard(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CARD_ID,
    title: "Карточка стенда",
    board: { id: BOARD_ID, title: "Проекты" },
    column: { id: CURRENT_COLUMN_ID, title: "Бэклог" },
    lane: { title: "Разработка" },
    owner: { id: 900, full_name: "Иванов И.", username: "ivanov" },
    properties: {},
    ...patch,
  };
}

function golden(name: string): Promise<string> {
  return Deno.readTextFile(
    new URL(`testdata/kiten-close/${name}`, import.meta.url),
  );
}

/** Голден под стенд: адрес карточки и метка старта таймера — свои. */
async function expected(
  name: string,
  baseUrl: string,
  startedAtMs?: number,
): Promise<string> {
  const text = (await golden(name)).replaceAll(
    GOLDEN_CARD_URL,
    `${baseUrl}/${CARD_ID}`,
  );
  return startedAtMs === undefined
    ? text
    : text.replace(GOLDEN_STAMP, `${mskStamp(startedAtMs)} МСК`);
}

/** Чем отвечать на «МЕТОД путь»; пара вне таблицы — красный тест. */
type Routes = Readonly<Record<string, (body: string) => Response>>;

interface Stand {
  readonly io: CommandIo;
  readonly baseUrl: string;
  readonly seen: readonly CapturedRequest[];
  readonly warnings: readonly string[];
  readonly db: () => ReturnType<typeof openCacheDb>;
  readonly stop: () => Promise<void>;
}

/** Стенд: фейковый Kaiten, env-файл под него и кэш-БД во временном каталоге. */
function stand(routes: Routes, env: Record<string, string> = {}): Stand {
  const fake = startFakeKaiten((seen) => {
    const last = seen[seen.length - 1];
    const route = routes[`${last.method} ${last.pathname}`];
    return route === undefined
      ? new Response("вызов, которого тест не ждал", { status: 500 })
      : route(last.body);
  });
  const values: Readonly<Record<string, string>> = {
    KITEN_API_KEY: API_KEY,
    KITEN_BASE_URL: fake.baseUrl,
    ...env,
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
    // строка легла в таблицу схемы. Закрывает её сама команда.
    openCacheDb: () => openCacheDb(`${dir}/cache.db`),
  });
  return {
    io,
    baseUrl: fake.baseUrl,
    seen: fake.seen,
    warnings,
    db: () => openCacheDb(`${dir}/cache.db`),
    stop: async () => {
      await fake.stop();
      Deno.removeSync(dir, { recursive: true });
    },
  };
}

/** Карточка отдаётся на GET, всё остальное — по таблице случая. */
function cardStand(
  card: Record<string, unknown>,
  extra: Routes = {},
  env: Record<string, string> = {},
): Stand {
  return stand({
    [`GET ${CARD_PATH}`]: () => Response.json(card),
    [`GET ${COLUMNS_PATH}`]: () => Response.json(COLUMNS),
    ...extra,
  }, env);
}

/** Текст вывода так, как его напечатает точка входа. */
async function output(
  argv: readonly string[],
  io: CommandIo,
): Promise<string> {
  const command: Command = kitenCloseCommand;
  return command.renderResult(await command.invoke(argv, io), argv);
}

/** Вызовы в порядке обращения: «МЕТОД путь». */
function calls(seen: readonly CapturedRequest[]): readonly string[] {
  return seen.map((request) => `${request.method} ${request.pathname}`);
}

/** Тела мутирующих запросов в порядке обращения. */
function bodies(seen: readonly CapturedRequest[]): readonly unknown[] {
  return seen.filter((request) => request.method !== "GET").map((request) =>
    JSON.parse(request.body)
  );
}

/** Строки журнала перемещений в порядке записи. */
function moveRows(stand: Stand): readonly Record<string, unknown>[] {
  using db = stand.db();
  // Схемы может не быть вовсе: команда, не дошедшая до переноса, БД не
  // открывает — читать пустой журнал всё равно нужно.
  db.bootstrap();
  return db.query(
    "SELECT * FROM kaiten_card_moves ORDER BY id",
  ) as unknown as readonly Record<string, unknown>[];
}

Deno.test("close --dry-run: план целиком, без единой мутации", async (t) => {
  await t.step("полный план — голден побайтово", async () => {
    const st = cardStand(rawCard());
    try {
      assertEquals(
        await output([
          SELECTOR,
          "--hypothesis",
          "Повтор запроса",
          "--done",
          "Починили",
          "--result",
          "Расход в норме",
          "--reply",
          "@all готово, проверьте",
          "--dry-run",
        ], st.io),
        await expected("dry-run-stdout.txt", st.baseUrl),
      );
      // Два чтения и ни одной мутации: карточка и колонки доски.
      assertEquals(calls(st.seen), [
        `GET ${CARD_PATH}`,
        `GET ${COLUMNS_PATH}`,
      ]);
    } finally {
      await st.stop();
    }
  });

  await t.step("--no-move — голден и одно чтение", async () => {
    const st = cardStand(rawCard());
    try {
      assertEquals(
        await output([SELECTOR, "--no-move", "--dry-run"], st.io),
        await expected("dry-run-no-move-stdout.txt", st.baseUrl),
      );
      // Колонки не читаются: переноса не будет, резолвить нечего.
      assertEquals(calls(st.seen), [`GET ${CARD_PATH}`]);
    } finally {
      await st.stop();
    }
  });

  await t.step("карточка уже в целевой колонке — план релога", async () => {
    const st = cardStand(
      rawCard({ column: { id: READY_COLUMN_ID, title: "Готово" } }),
    );
    try {
      assertStringIncludes(
        await output([SELECTOR, "--dry-run"], st.io),
        `dry-run: релог (влево→обратно) → «Готово» (колонка ${READY_COLUMN_ID}); ` +
          "сейчас Проекты · Готово · Разработка; PATCH не отправлен\n",
      );
    } finally {
      await st.stop();
    }
  });

  await t.step("идущий таймер без флага — строка предупреждения", async () => {
    const startedAtMs = startedHalfMinuteAgo();
    const st = cardStand(rawCard({ timer: rawTimer(startedAtMs) }));
    try {
      assertStringIncludes(
        await output([SELECTOR, "--no-move", "--dry-run"], st.io),
        `  таймер: на карточке запущен таймер (с ${
          mskStamp(startedAtMs)
        } МСК, 1 мин); он НЕ остановлен — ` +
          `\`mpu kiten time stop ${CARD_ID}\` (или --stop-timer)\n`,
      );
      // План не трогает таймер даже предупреждением в stderr.
      assertEquals(st.warnings, []);
    } finally {
      await st.stop();
    }
  });

  await t.step("--stop-timer — план остановки с длительностью", async () => {
    const startedAtMs = startedHalfMinuteAgo();
    const st = cardStand(rawCard({ timer: rawTimer(startedAtMs) }));
    try {
      assertStringIncludes(
        await output(
          [SELECTOR, "--no-move", "--stop-timer", "--dry-run"],
          st.io,
        ),
        `  таймер: остановить (запущен с ${
          mskStamp(startedAtMs)
        } МСК, 1 мин)\n`,
      );
      assertEquals(calls(st.seen), [`GET ${CARD_PATH}`]);
    } finally {
      await st.stop();
    }
  });

  await t.step(
    "таймер без метки старта — «с ?» и без длительности",
    async () => {
      const st = cardStand(
        rawCard({
          timer: { id: TIMER_ID, card_id: CARD_ID, started_at: null },
        }),
      );
      try {
        assertStringIncludes(
          await output(
            [SELECTOR, "--no-move", "--stop-timer", "--dry-run"],
            st.io,
          ),
          "  таймер: остановить (запущен с ?)\n",
        );
      } finally {
        await st.stop();
      }
    },
  );
});

Deno.test("close: поля пишутся по одному и только в пустые", async (t) => {
  await t.step("три поля — голден и три PATCH", async () => {
    const st = cardStand(rawCard(), {
      [`PATCH ${CARD_PATH}`]: () => Response.json(rawCard()),
    });
    try {
      assertEquals(
        await output([
          SELECTOR,
          "--hypothesis",
          "Повтор запроса",
          "--done",
          "Починили",
          "--result",
          "Расход в норме",
          "--no-move",
        ], st.io),
        await expected("apply-fields-stdout.txt", st.baseUrl),
      );
      assertEquals(calls(st.seen), [
        `GET ${CARD_PATH}`,
        `PATCH ${CARD_PATH}`,
        `PATCH ${CARD_PATH}`,
        `PATCH ${CARD_PATH}`,
      ]);
      // Порядок обработки фиксирован спекой и не зависит от argv.
      assertEquals(bodies(st.seen), [
        { properties: { [HYPOTHESIS]: "Повтор запроса" } },
        { properties: { [DONE]: "Починили" } },
        { properties: { [RESULT]: "Расход в норме" } },
      ]);
    } finally {
      await st.stop();
    }
  });

  await t.step("заполненное поле пропускается — голден", async () => {
    const st = cardStand(
      rawCard({ properties: { [HYPOTHESIS]: "уже написано" } }),
    );
    try {
      assertEquals(
        await output([SELECTOR, "--hypothesis", "Повтор", "--no-move"], st.io),
        await expected("apply-fields-skipped-stdout.txt", st.baseUrl),
      );
      assertEquals(calls(st.seen), [`GET ${CARD_PATH}`]);
    } finally {
      await st.stop();
    }
  });

  await t.step("значение из пробелов — поле считается пустым", async () => {
    const st = cardStand(rawCard({ properties: { [DONE]: "   " } }), {
      [`PATCH ${CARD_PATH}`]: () => Response.json(rawCard()),
    });
    try {
      assertStringIncludes(
        await output([SELECTOR, "--done", "Починили", "--no-move"], st.io),
        "ok close: поля [done]\n",
      );
    } finally {
      await st.stop();
    }
  });

  await t.step("--force-fields пишет поверх заполненного", async () => {
    const st = cardStand(rawCard({ properties: { [DONE]: "старое" } }), {
      [`PATCH ${CARD_PATH}`]: () => Response.json(rawCard()),
    });
    try {
      assertStringIncludes(
        await output([
          SELECTOR,
          "--done",
          "новое",
          "--force-fields",
          "--no-move",
        ], st.io),
        "ok close: поля [done]\n",
      );
      assertEquals(bodies(st.seen), [{ properties: { [DONE]: "новое" } }]);
    } finally {
      await st.stop();
    }
  });
});

Deno.test("close --stop-timer: запись создаётся и перечитывается", async (t) => {
  const routes = (startedAtMs: number): Routes => ({
    [`GET ${ROLES_PATH}`]: () =>
      Response.json([{ id: ROLE_ID, name: "Техподдержка" }]),
    [`PATCH ${TIMER_PATH}`]: () =>
      Response.json({
        ...rawTimer(startedAtMs),
        card_time_log_id: LOG_ID,
        finished_at: new Date().toISOString(),
      }),
    [`GET ${TIME_LOGS_PATH}`]: () =>
      Response.json([{
        id: LOG_ID,
        card_id: CARD_ID,
        time_spent: 1,
        for_date: "2026-08-14",
        role_id: ROLE_ID,
        comment: "разбор жалобы",
      }]),
  });

  await t.step("голден строки таймера и состав вызовов", async () => {
    const startedAtMs = startedHalfMinuteAgo();
    const st = cardStand(
      rawCard({ timer: rawTimer(startedAtMs) }),
      routes(startedAtMs),
    );
    try {
      assertEquals(
        await output([SELECTOR, "--no-move", "--stop-timer"], st.io),
        await expected("apply-timer-stopped-stdout.txt", st.baseUrl),
      );
      assertEquals(calls(st.seen), [
        `GET ${CARD_PATH}`,
        `GET ${ROLES_PATH}`,
        `PATCH ${TIMER_PATH}`,
        `GET ${TIME_LOGS_PATH}`,
      ]);
      // Комментарий таймера уходит в запись: сервер его не переносит.
      assertEquals(bodies(st.seen), [{
        finished_at: bodies(st.seen)[0]
          ? (bodies(st.seen)[0] as { finished_at: string }).finished_at
          : "",
        comment: "разбор жалобы",
        role_id: ROLE_ID,
      }]);
      assertEquals(st.warnings, []);
    } finally {
      await st.stop();
    }
  });

  await t.step("роль берётся из env-файла, а не из подсказки", async () => {
    const startedAtMs = startedHalfMinuteAgo();
    const st = cardStand(
      rawCard({ timer: rawTimer(startedAtMs) }),
      {
        ...routes(startedAtMs),
        [`GET ${ROLES_PATH}`]: () =>
          Response.json([
            { id: ROLE_ID, name: "Техподдержка" },
            { id: 12060, name: "Диагностика" },
          ]),
      },
      { KITEN_TIME_ROLE: "Диагностика" },
    );
    try {
      assertStringIncludes(
        await output([SELECTOR, "--no-move", "--stop-timer"], st.io),
        "запись 7000001",
      );
      assertEquals(
        (bodies(st.seen)[0] as { role_id: number }).role_id,
        12060,
      );
    } finally {
      await st.stop();
    }
  });

  await t.step(
    "сервер не назвал id записи — факт остановки виден",
    async () => {
      const startedAtMs = startedHalfMinuteAgo();
      const st = cardStand(rawCard({ timer: rawTimer(startedAtMs) }), {
        [`GET ${ROLES_PATH}`]: () =>
          Response.json([{ id: ROLE_ID, name: "Техподдержка" }]),
        [`PATCH ${TIMER_PATH}`]: () => Response.json(rawTimer(startedAtMs)),
      });
      try {
        assertEquals(
          await output([SELECTOR, "--no-move", "--stop-timer"], st.io),
          "ok close: поля [—]\n   таймер: остановлен\n",
        );
        // Записи перечитывать нечего: id её сервер не назвал.
        assertEquals(calls(st.seen).includes(`GET ${TIME_LOGS_PATH}`), false);
      } finally {
        await st.stop();
      }
    },
  );

  await t.step("таймера нет — шаг молча пропущен", async () => {
    const st = cardStand(rawCard());
    try {
      assertEquals(
        await output([SELECTOR, "--no-move", "--stop-timer"], st.io),
        "ok close: поля [—]\n",
      );
      assertEquals(calls(st.seen), [`GET ${CARD_PATH}`]);
    } finally {
      await st.stop();
    }
  });

  await t.step("без флага таймер не трогается — предупреждение", async () => {
    const startedAtMs = startedHalfMinuteAgo();
    const st = cardStand(rawCard({ timer: rawTimer(startedAtMs) }));
    try {
      assertEquals(
        await output([SELECTOR, "--no-move"], st.io),
        "ok close: поля [—]\n",
      );
      assertEquals(
        st.warnings.map((line) => `${line}\n`),
        [
          await expected(
            "warn-timer-running-stderr.txt",
            st.baseUrl,
            startedAtMs,
          ),
        ],
      );
      // Ни остановки, ни записи учёта времени: только чтение карточки.
      assertEquals(calls(st.seen), [`GET ${CARD_PATH}`]);
    } finally {
      await st.stop();
    }
  });
});

Deno.test("close: ответ клиенту — комментарий без вложений", async (t) => {
  const commentRoute: Routes = {
    [`POST ${COMMENTS_PATH}`]: () =>
      Response.json({ id: COMMENT_ID, text: "готово" }),
  };

  await t.step(
    "@all раскрыт во владельца; текст уходит раскрытым",
    async () => {
      const st = cardStand(rawCard(), commentRoute);
      try {
        assertEquals(
          await output([
            SELECTOR,
            "--reply",
            "@all готово, проверьте",
            "--no-move",
          ], st.io),
          `ok close: поля [—]\n   ответ: комментарий ${COMMENT_ID} (@all → @ivanov)\n`,
        );
        assertEquals(bodies(st.seen), [{ text: "@ivanov готово, проверьте" }]);
      } finally {
        await st.stop();
      }
    },
  );

  await t.step("владельца нет — предупреждение, @all остаётся", async () => {
    const st = cardStand(rawCard({ owner: null }), commentRoute);
    try {
      assertStringIncludes(
        await output([SELECTOR, "--reply", "@all готово", "--no-move"], st.io),
        `   ответ: комментарий ${COMMENT_ID}\n`,
      );
      assertEquals(bodies(st.seen), [{ text: "@all готово" }]);
      assertEquals(st.warnings, [
        "mpu kiten close: у карточки нет владельца — '@all' оставлен как есть",
      ]);
    } finally {
      await st.stop();
    }
  });

  await t.step("предупреждение о владельце печатается и в плане", async () => {
    const st = cardStand(rawCard({ owner: null }));
    try {
      assertStringIncludes(
        await output([
          SELECTOR,
          "--reply",
          "@all готово",
          "--no-move",
          "--dry-run",
        ], st.io),
        "  ответ: запостить\n",
      );
      assertEquals(st.warnings.length, 1);
    } finally {
      await st.stop();
    }
  });

  await t.step("текст из stdin", async () => {
    const st = cardStand(rawCard(), commentRoute);
    const io = { ...st.io, readTextStdin: () => Promise.resolve("из пайпа") };
    try {
      await output([SELECTOR, "--reply-file", "-", "--no-move"], io);
      assertEquals(bodies(st.seen), [{ text: "из пайпа" }]);
    } finally {
      await st.stop();
    }
  });
});

Deno.test("close: перенос — PATCH, свежее чтение и строка журнала", async (t) => {
  await t.step("обычное перемещение: один PATCH и ok-строка", async () => {
    const after = rawCard({ column: { id: READY_COLUMN_ID, title: "Готово" } });
    const st = cardStand(rawCard(), {
      [`PATCH ${CARD_PATH}`]: () => Response.json(after),
    });
    try {
      assertEquals(
        await output([SELECTOR], st.io),
        `ok close: поля [—]\nok: Проекты · Бэклог · Разработка → ` +
          `Проекты · Готово · Разработка · ${st.baseUrl}/${CARD_ID}\n`,
      );
      assertEquals(calls(st.seen), [
        `GET ${CARD_PATH}`,
        `GET ${COLUMNS_PATH}`,
        `PATCH ${CARD_PATH}`,
      ]);
      assertEquals(bodies(st.seen), [{ column_id: READY_COLUMN_ID }]);
      const rows = moveRows(st);
      assertEquals(rows.length, 1);
      assertEquals(rows[0].card_id, CARD_ID);
      assertEquals(rows[0].to_column, "Готово");
      assertEquals(rows[0].from_column, "Бэклог");
      assertEquals(rows[0].lane, "Разработка");
      assertEquals(rows[0].board, "Проекты");
      assertEquals(rows[0].note, "");
      assertEquals(rows[0].url, `${st.baseUrl}/${CARD_ID}`);
    } finally {
      await st.stop();
    }
  });

  await t.step(
    "карточка уже в целевой колонке — релог двумя PATCH",
    async () => {
      const card = rawCard({
        column: { id: READY_COLUMN_ID, title: "Готово" },
      });
      const st = cardStand(card, {
        [`PATCH ${CARD_PATH}`]: () => Response.json(card),
      });
      try {
        assertStringIncludes(
          await output([SELECTOR], st.io),
          `Проекты · Готово · Разработка (релог) · ${st.baseUrl}/${CARD_ID}\n`,
        );
        // Сосед — предыдущая колонка по sort_order, а не по порядку ответа.
        assertEquals(bodies(st.seen), [
          { column_id: 5000003 },
          { column_id: READY_COLUMN_ID },
        ]);
      } finally {
        await st.stop();
      }
    },
  );

  await t.step("крайняя левая цель — сосед справа", async () => {
    const card = rawCard({
      column: { id: CURRENT_COLUMN_ID, title: "Бэклог" },
    });
    const st = cardStand(card, {
      [`PATCH ${CARD_PATH}`]: () => Response.json(card),
    });
    try {
      await output([SELECTOR, "--column", "Бэклог"], st.io);
      assertEquals(bodies(st.seen), [
        { column_id: 5000003 },
        { column_id: CURRENT_COLUMN_ID },
      ]);
    } finally {
      await st.stop();
    }
  });

  await t.step("релог на доске с одной колонкой — exit 2", async () => {
    const card = rawCard({ column: { id: READY_COLUMN_ID, title: "Готово" } });
    const st = stand({
      [`GET ${CARD_PATH}`]: () => Response.json(card),
      [`GET ${COLUMNS_PATH}`]: () => Response.json([COLUMNS[0]]),
    });
    try {
      const err = await assertRejects(
        () => kitenCloseCommand.invoke([SELECTOR], st.io),
        UsageError,
      );
      assertEquals(err.message, "на доске одна колонка — релог невозможен");
      assertEquals(calls(st.seen), [
        `GET ${CARD_PATH}`,
        `GET ${COLUMNS_PATH}`,
      ]);
    } finally {
      await st.stop();
    }
  });

  await t.step("колонка из env-файла", async () => {
    const after = rawCard({ column: { id: 5000003, title: "В работе" } });
    const st = cardStand(rawCard(), {
      [`PATCH ${CARD_PATH}`]: () => Response.json(after),
    }, { KITEN_READY_COLUMN: "В работе" });
    try {
      await output([SELECTOR], st.io);
      assertEquals(bodies(st.seen), [{ column_id: 5000003 }]);
    } finally {
      await st.stop();
    }
  });

  await t.step("--no-move: ни PATCH, ни строки журнала", async () => {
    const st = cardStand(rawCard());
    try {
      await output([SELECTOR, "--no-move"], st.io);
      assertEquals(calls(st.seen), [`GET ${CARD_PATH}`]);
      // Кэш-БД не открывалась вовсе: журнал пополняет только перенос.
      assertEquals(moveRows(st).length, 0);
    } finally {
      await st.stop();
    }
  });
});

Deno.test("close: ошибки ввода — до первой мутации", async (t) => {
  await t.step("оба источника ответа — голден текста", async () => {
    const st = stand({});
    try {
      const err = await assertRejects(
        () =>
          kitenCloseCommand.invoke(
            [SELECTOR, "--reply", "текст", "--reply-file", "x.md"],
            st.io,
          ),
        UsageError,
      );
      assertEquals(
        `${err.message}\n`,
        await golden("err-reply-both-message.txt"),
      );
      assertEquals(calls(st.seen), []);
    } finally {
      await st.stop();
    }
  });

  await t.step("пустой текст ответа — голден текста", async () => {
    const st = stand({});
    try {
      const err = await assertRejects(
        () => kitenCloseCommand.invoke([SELECTOR, "--reply", "   "], st.io),
        UsageError,
      );
      assertEquals(
        `${err.message}\n`,
        await golden("err-reply-empty-message.txt"),
      );
      assertEquals(calls(st.seen), []);
    } finally {
      await st.stop();
    }
  });

  await t.step("нечитаемый --reply-file — префикс причины", async () => {
    const st = stand({});
    try {
      const err = await assertRejects(
        () =>
          kitenCloseCommand.invoke(
            [SELECTOR, "--reply-file", "/нет/такого.md"],
            st.io,
          ),
        UsageError,
      );
      assertStringIncludes(
        err.message,
        "не удалось прочитать /нет/такого.md: ",
      );
      assertEquals(calls(st.seen), []);
    } finally {
      await st.stop();
    }
  });

  await t.step(
    "колонка не резолвится — голден и ни одной мутации",
    async () => {
      const startedAtMs = startedHalfMinuteAgo();
      const st = cardStand(rawCard({ timer: rawTimer(startedAtMs) }));
      try {
        const err = await assertRejects(
          () =>
            kitenCloseCommand.invoke([
              SELECTOR,
              "--column",
              "Такой колонки нет",
              "--done",
              "Починили",
              "--reply",
              "готово",
              "--stop-timer",
            ], st.io),
          UsageError,
        );
        assertEquals(
          `${err.message}\n`,
          await golden("err-column-unresolved-message.txt"),
        );
        // Резолв идёт сразу за стартовым чтением: ни таймер, ни поля, ни
        // ответ к этому моменту не тронуты (`kiten-close.md`, вердикт fix).
        assertEquals(calls(st.seen), [
          `GET ${CARD_PATH}`,
          `GET ${COLUMNS_PATH}`,
        ]);
      } finally {
        await st.stop();
      }
    },
  );

  await t.step("числовая колонка чужой доски — тот же отказ", async () => {
    const st = cardStand(rawCard());
    try {
      const err = await assertRejects(
        () => kitenCloseCommand.invoke([SELECTOR, "--column", "999"], st.io),
        UsageError,
      );
      assertEquals(
        err.message,
        "column '999' не найден — см. `mpu kiten columns`",
      );
    } finally {
      await st.stop();
    }
  });

  await t.step("неоднозначная колонка — кандидаты списком", async () => {
    const st = cardStand(rawCard());
    try {
      const err = await assertRejects(
        () => kitenCloseCommand.invoke([SELECTOR, "--column", "о"], st.io),
        UsageError,
      );
      assertStringIncludes(
        err.message,
        "column 'о' неоднозначен (3 совпадений):",
      );
    } finally {
      await st.stop();
    }
  });

  await t.step("числовая колонка своей доски — резолв без поиска", async () => {
    const after = rawCard({ column: { id: 5000003, title: "В работе" } });
    const st = cardStand(rawCard(), {
      [`PATCH ${CARD_PATH}`]: () => Response.json(after),
    });
    try {
      await output([SELECTOR, "--column", "5000003"], st.io);
      assertEquals(bodies(st.seen), [{ column_id: 5000003 }]);
    } finally {
      await st.stop();
    }
  });

  await t.step("у карточки нет доски — переносить некуда", async () => {
    const st = cardStand(rawCard({ board: null }));
    try {
      const err = await assertRejects(
        () => kitenCloseCommand.invoke([SELECTOR], st.io),
        DomainError,
      );
      assertEquals(err.message, "у карточки нет доски — переносить некуда");
      assertEquals(calls(st.seen), [`GET ${CARD_PATH}`]);
    } finally {
      await st.stop();
    }
  });

  await t.step("колонки доски не прочитались — отказ API", async () => {
    const st = stand({
      [`GET ${CARD_PATH}`]: () => Response.json(rawCard()),
      [`GET ${COLUMNS_PATH}`]: () => new Response("boom", { status: 500 }),
    });
    try {
      const err = await assertRejects(
        () => kitenCloseCommand.invoke([SELECTOR], st.io),
        DomainError,
      );
      assertStringIncludes(err.message, "kaiten error: ");
    } finally {
      await st.stop();
    }
  });

  await t.step("селектор без числового сегмента", async () => {
    const st = stand({});
    try {
      await assertRejects(
        () => kitenCloseCommand.invoke(["abc"], st.io),
        UsageError,
      );
      assertEquals(calls(st.seen), []);
    } finally {
      await st.stop();
    }
  });
});

Deno.test("close: отказ шага назван в тексте ошибки", async (t) => {
  const failure = () => new Response("boom", { status: 500 });

  await t.step("стартовое чтение — без маркера шага", async () => {
    const st = stand({ [`GET ${CARD_PATH}`]: failure });
    try {
      const err = await assertRejects(
        () => kitenCloseCommand.invoke([SELECTOR, "--no-move"], st.io),
        DomainError,
      );
      assertStringIncludes(err.message, "kaiten error: ");
      assertEquals(err.message.includes("("), false);
    } finally {
      await st.stop();
    }
  });

  await t.step("таймер — маркер (таймер)", async () => {
    const startedAtMs = startedHalfMinuteAgo();
    const st = cardStand(rawCard({ timer: rawTimer(startedAtMs) }), {
      [`GET ${ROLES_PATH}`]: () => Response.json([]),
      [`PATCH ${TIMER_PATH}`]: failure,
    });
    try {
      const err = await assertRejects(
        () =>
          kitenCloseCommand.invoke(
            [SELECTOR, "--no-move", "--stop-timer"],
            st.io,
          ),
        DomainError,
      );
      assertStringIncludes(err.message, "kaiten error (таймер): ");
    } finally {
      await st.stop();
    }
  });

  await t.step("поля — маркер (поля), таймер уже остановлен", async () => {
    const startedAtMs = startedHalfMinuteAgo();
    const st = cardStand(rawCard({ timer: rawTimer(startedAtMs) }), {
      [`GET ${ROLES_PATH}`]: () =>
        Response.json([{ id: ROLE_ID, name: "Техподдержка" }]),
      [`PATCH ${TIMER_PATH}`]: () =>
        Response.json({ ...rawTimer(startedAtMs), card_time_log_id: LOG_ID }),
      [`GET ${TIME_LOGS_PATH}`]: () => Response.json([]),
      [`PATCH ${CARD_PATH}`]: failure,
    });
    try {
      const err = await assertRejects(
        () =>
          kitenCloseCommand.invoke([
            SELECTOR,
            "--no-move",
            "--stop-timer",
            "--done",
            "Починили",
          ], st.io),
        DomainError,
      );
      assertStringIncludes(err.message, "kaiten error (поля): ");
      // Ранние шаги остаются применёнными: сквозного отката нет.
      assertEquals(calls(st.seen).includes(`PATCH ${TIMER_PATH}`), true);
    } finally {
      await st.stop();
    }
  });

  await t.step("ответ — маркер (ответ), поля уже записаны", async () => {
    const st = cardStand(rawCard(), {
      [`PATCH ${CARD_PATH}`]: () => Response.json(rawCard()),
      [`POST ${COMMENTS_PATH}`]: failure,
    });
    try {
      const err = await assertRejects(
        () =>
          kitenCloseCommand.invoke([
            SELECTOR,
            "--no-move",
            "--done",
            "Починили",
            "--reply",
            "готово",
          ], st.io),
        DomainError,
      );
      assertStringIncludes(err.message, "kaiten error (ответ): ");
      assertEquals(calls(st.seen), [
        `GET ${CARD_PATH}`,
        `PATCH ${CARD_PATH}`,
        `POST ${COMMENTS_PATH}`,
      ]);
    } finally {
      await st.stop();
    }
  });

  await t.step("перенос — формат move, без маркера и без журнала", async () => {
    const st = cardStand(rawCard(), { [`PATCH ${CARD_PATH}`]: failure });
    try {
      const err = await assertRejects(
        () => kitenCloseCommand.invoke([SELECTOR], st.io),
        DomainError,
      );
      assertStringIncludes(err.message, "kaiten error: ");
      assertEquals(moveRows(st).length, 0);
    } finally {
      await st.stop();
    }
  });
});

Deno.test("close: ненастроенный KITEN_API_KEY — ошибка ввода", async () => {
  const io = makeFakeIo({
    envFile: {
      get: () => undefined,
      values: () => ({}),
      require: () => "",
      set: () => Promise.resolve(),
    },
  });
  await assertRejects(
    () => kitenCloseCommand.invoke([SELECTOR], io),
    UsageError,
  );
});
