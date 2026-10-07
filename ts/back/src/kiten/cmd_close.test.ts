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

import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rejected } from "../testing/thrown.ts";
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
  return readFile(
    new URL(`testdata/kiten-close/${name}`, import.meta.url),
    "utf8",
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
      rmSync(dir, { recursive: true });
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

/**
 * Ответ Kaiten на PATCH перемещения: оси — только id, названий доски,
 * колонки и дорожки нет (`kiten-move.md`, «Ввод/вывод»). Фикстура
 * повторяет эту бедность: ответь стенд полной карточкой — и положение
 * «после», взятое из ответа мутации, прошло бы проверку.
 */
function rawPatchedCard(columnId: number): Record<string, unknown> {
  return {
    id: CARD_ID,
    title: "Карточка стенда",
    board_id: BOARD_ID,
    column_id: columnId,
    lane_id: 6000001,
  };
}

/**
 * Стенд переноса: до первого PATCH карточка читается как `before`,
 * после — как `after`, а сам PATCH отвечает по-серверному бедно.
 */
function movingStand(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  columnId: number,
  env: Record<string, string> = {},
): Stand {
  let moved = false;
  return stand({
    [`GET ${CARD_PATH}`]: () => Response.json(moved ? after : before),
    [`GET ${COLUMNS_PATH}`]: () => Response.json(COLUMNS),
    [`PATCH ${CARD_PATH}`]: () => {
      moved = true;
      return Response.json(rawPatchedCard(columnId));
    },
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

describe("close --dry-run: план целиком, без единой мутации", () => {
  it("полный план — голден побайтово", async () => {
    const st = cardStand(rawCard());
    try {
      expect(
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
      ).toStrictEqual(await expected("dry-run-stdout.txt", st.baseUrl));
      // Два чтения и ни одной мутации: карточка и колонки доски.
      expect(calls(st.seen)).toStrictEqual([
        `GET ${CARD_PATH}`,
        `GET ${COLUMNS_PATH}`,
      ]);
    } finally {
      await st.stop();
    }
  });

  it("--no-move — голден и одно чтение", async () => {
    const st = cardStand(rawCard());
    try {
      expect(await output([SELECTOR, "--no-move", "--dry-run"], st.io))
        .toStrictEqual(
          await expected("dry-run-no-move-stdout.txt", st.baseUrl),
        );
      // Колонки не читаются: переноса не будет, резолвить нечего.
      expect(calls(st.seen)).toStrictEqual([`GET ${CARD_PATH}`]);
    } finally {
      await st.stop();
    }
  });

  it("карточка уже в целевой колонке — план релога", async () => {
    const st = cardStand(
      rawCard({ column: { id: READY_COLUMN_ID, title: "Готово" } }),
    );
    try {
      expect(await output([SELECTOR, "--dry-run"], st.io)).toContain(
        `dry-run: релог (влево→обратно) → «Готово» (колонка ${READY_COLUMN_ID}); ` +
          "сейчас Проекты · Готово · Разработка; PATCH не отправлен\n",
      );
    } finally {
      await st.stop();
    }
  });

  it("идущий таймер без флага — строка предупреждения", async () => {
    const startedAtMs = startedHalfMinuteAgo();
    const st = cardStand(rawCard({ timer: rawTimer(startedAtMs) }));
    try {
      expect(await output([SELECTOR, "--no-move", "--dry-run"], st.io))
        .toContain(
          `  таймер: на карточке запущен таймер (с ${
            mskStamp(startedAtMs)
          } МСК, 1 мин); он НЕ остановлен — ` +
            `\`mpu kiten time stop id: ${CARD_ID}\` (или stop-timer)\n`,
        );
      // План не трогает таймер даже предупреждением в stderr.
      expect(st.warnings).toStrictEqual([]);
    } finally {
      await st.stop();
    }
  });

  it("--stop-timer — план остановки с длительностью", async () => {
    const startedAtMs = startedHalfMinuteAgo();
    const st = cardStand(rawCard({ timer: rawTimer(startedAtMs) }));
    try {
      expect(
        await output(
          [SELECTOR, "--no-move", "--stop-timer", "--dry-run"],
          st.io,
        ),
      ).toContain(
        `  таймер: остановить (запущен с ${
          mskStamp(startedAtMs)
        } МСК, 1 мин)\n`,
      );
      expect(calls(st.seen)).toStrictEqual([`GET ${CARD_PATH}`]);
    } finally {
      await st.stop();
    }
  });

  it("таймер без метки старта — «с ?» и без длительности", async () => {
    const st = cardStand(
      rawCard({
        timer: { id: TIMER_ID, card_id: CARD_ID, started_at: null },
      }),
    );
    try {
      expect(
        await output(
          [SELECTOR, "--no-move", "--stop-timer", "--dry-run"],
          st.io,
        ),
      ).toContain("  таймер: остановить (запущен с ?)\n");
    } finally {
      await st.stop();
    }
  });
});

describe("close: поля пишутся по одному и только в пустые", () => {
  it("три поля — голден и три PATCH", async () => {
    const st = cardStand(rawCard(), {
      [`PATCH ${CARD_PATH}`]: () => Response.json(rawCard()),
    });
    try {
      expect(
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
      ).toStrictEqual(await expected("apply-fields-stdout.txt", st.baseUrl));
      expect(calls(st.seen)).toStrictEqual([
        `GET ${CARD_PATH}`,
        `PATCH ${CARD_PATH}`,
        `PATCH ${CARD_PATH}`,
        `PATCH ${CARD_PATH}`,
      ]);
      // Порядок обработки фиксирован спекой и не зависит от argv.
      expect(bodies(st.seen)).toStrictEqual([
        { properties: { [HYPOTHESIS]: "Повтор запроса" } },
        { properties: { [DONE]: "Починили" } },
        { properties: { [RESULT]: "Расход в норме" } },
      ]);
    } finally {
      await st.stop();
    }
  });

  it("заполненное поле пропускается — голден", async () => {
    const st = cardStand(
      rawCard({ properties: { [HYPOTHESIS]: "уже написано" } }),
    );
    try {
      expect(
        await output([SELECTOR, "--hypothesis", "Повтор", "--no-move"], st.io),
      ).toStrictEqual(
        await expected("apply-fields-skipped-stdout.txt", st.baseUrl),
      );
      expect(calls(st.seen)).toStrictEqual([`GET ${CARD_PATH}`]);
    } finally {
      await st.stop();
    }
  });

  it("значение из пробелов — поле считается пустым", async () => {
    const st = cardStand(rawCard({ properties: { [DONE]: "   " } }), {
      [`PATCH ${CARD_PATH}`]: () => Response.json(rawCard()),
    });
    try {
      expect(await output([SELECTOR, "--done", "Починили", "--no-move"], st.io))
        .toContain("ok close: поля [done]\n");
    } finally {
      await st.stop();
    }
  });

  it("--force-fields пишет поверх заполненного", async () => {
    const st = cardStand(rawCard({ properties: { [DONE]: "старое" } }), {
      [`PATCH ${CARD_PATH}`]: () => Response.json(rawCard()),
    });
    try {
      expect(
        await output([
          SELECTOR,
          "--done",
          "новое",
          "--force-fields",
          "--no-move",
        ], st.io),
      ).toContain("ok close: поля [done]\n");
      expect(bodies(st.seen)).toStrictEqual([{
        properties: { [DONE]: "новое" },
      }]);
    } finally {
      await st.stop();
    }
  });
});

describe("close --stop-timer: запись создаётся и перечитывается", () => {
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

  it("голден строки таймера и состав вызовов", async () => {
    const startedAtMs = startedHalfMinuteAgo();
    const st = cardStand(
      rawCard({ timer: rawTimer(startedAtMs) }),
      routes(startedAtMs),
    );
    try {
      expect(await output([SELECTOR, "--no-move", "--stop-timer"], st.io))
        .toStrictEqual(
          await expected("apply-timer-stopped-stdout.txt", st.baseUrl),
        );
      expect(calls(st.seen)).toStrictEqual([
        `GET ${CARD_PATH}`,
        `GET ${ROLES_PATH}`,
        `PATCH ${TIMER_PATH}`,
        `GET ${TIME_LOGS_PATH}`,
      ]);
      // Комментарий таймера уходит в запись: сервер его не переносит.
      expect(bodies(st.seen)).toStrictEqual([{
        finished_at: bodies(st.seen)[0]
          ? (bodies(st.seen)[0] as { finished_at: string }).finished_at
          : "",
        comment: "разбор жалобы",
        role_id: ROLE_ID,
      }]);
      expect(st.warnings).toStrictEqual([]);
    } finally {
      await st.stop();
    }
  });

  it("роль берётся из env-файла, а не из подсказки", async () => {
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
      expect(await output([SELECTOR, "--no-move", "--stop-timer"], st.io))
        .toContain("запись 7000001");
      expect((bodies(st.seen)[0] as { role_id: number }).role_id).toBe(12060);
    } finally {
      await st.stop();
    }
  });

  it("сервер не назвал id записи — факт остановки виден", async () => {
    const startedAtMs = startedHalfMinuteAgo();
    const st = cardStand(rawCard({ timer: rawTimer(startedAtMs) }), {
      [`GET ${ROLES_PATH}`]: () =>
        Response.json([{ id: ROLE_ID, name: "Техподдержка" }]),
      [`PATCH ${TIMER_PATH}`]: () => Response.json(rawTimer(startedAtMs)),
    });
    try {
      expect(await output([SELECTOR, "--no-move", "--stop-timer"], st.io)).toBe(
        "ok close: поля [—]\n   таймер: остановлен\n",
      );
      // Записи перечитывать нечего: id её сервер не назвал.
      expect(calls(st.seen).includes(`GET ${TIME_LOGS_PATH}`)).toBe(false);
    } finally {
      await st.stop();
    }
  });

  it("таймера нет — шаг молча пропущен", async () => {
    const st = cardStand(rawCard());
    try {
      expect(await output([SELECTOR, "--no-move", "--stop-timer"], st.io)).toBe(
        "ok close: поля [—]\n",
      );
      expect(calls(st.seen)).toStrictEqual([`GET ${CARD_PATH}`]);
    } finally {
      await st.stop();
    }
  });

  it("без флага таймер не трогается — предупреждение", async () => {
    const startedAtMs = startedHalfMinuteAgo();
    const st = cardStand(rawCard({ timer: rawTimer(startedAtMs) }));
    try {
      expect(await output([SELECTOR, "--no-move"], st.io)).toBe(
        "ok close: поля [—]\n",
      );
      expect(st.warnings.map((line) => `${line}\n`)).toStrictEqual([
        await expected(
          "warn-timer-running-stderr.txt",
          st.baseUrl,
          startedAtMs,
        ),
      ]);
      // Ни остановки, ни записи учёта времени: только чтение карточки.
      expect(calls(st.seen)).toStrictEqual([`GET ${CARD_PATH}`]);
    } finally {
      await st.stop();
    }
  });
});

describe("close: ответ клиенту — комментарий без вложений", () => {
  const commentRoute: Routes = {
    [`POST ${COMMENTS_PATH}`]: () =>
      Response.json({ id: COMMENT_ID, text: "готово" }),
  };

  it("@all раскрыт во владельца; текст уходит раскрытым", async () => {
    const st = cardStand(rawCard(), commentRoute);
    try {
      expect(
        await output([
          SELECTOR,
          "--reply",
          "@all готово, проверьте",
          "--no-move",
        ], st.io),
      ).toStrictEqual(
        `ok close: поля [—]\n   ответ: комментарий ${COMMENT_ID} (@all → @ivanov)\n`,
      );
      expect(bodies(st.seen)).toStrictEqual([{
        text: "@ivanov готово, проверьте",
      }]);
    } finally {
      await st.stop();
    }
  });

  it("владельца нет — предупреждение, @all остаётся", async () => {
    const st = cardStand(rawCard({ owner: null }), commentRoute);
    try {
      expect(
        await output([SELECTOR, "--reply", "@all готово", "--no-move"], st.io),
      ).toContain(`   ответ: комментарий ${COMMENT_ID}\n`);
      expect(bodies(st.seen)).toStrictEqual([{ text: "@all готово" }]);
      expect(st.warnings).toStrictEqual([
        "mpu kiten close: у карточки нет владельца — '@all' оставлен как есть",
      ]);
    } finally {
      await st.stop();
    }
  });

  it("предупреждение о владельце печатается и в плане", async () => {
    const st = cardStand(rawCard({ owner: null }));
    try {
      expect(
        await output([
          SELECTOR,
          "--reply",
          "@all готово",
          "--no-move",
          "--dry-run",
        ], st.io),
      ).toContain("  ответ: запостить\n");
      expect(st.warnings.length).toBe(1);
    } finally {
      await st.stop();
    }
  });

  it("текст из stdin", async () => {
    const st = cardStand(rawCard(), commentRoute);
    const io = {
      ...st.io,
      readStdin: () => Promise.resolve(new TextEncoder().encode("из пайпа")),
    };
    try {
      await output([SELECTOR, "--reply-file", "-", "--no-move"], io);
      expect(bodies(st.seen)).toStrictEqual([{ text: "из пайпа" }]);
    } finally {
      await st.stop();
    }
  });
});

describe("close: перенос — PATCH, свежее чтение и строка журнала", () => {
  it("обычное перемещение: один PATCH и ok-строка", async () => {
    const after = rawCard({ column: { id: READY_COLUMN_ID, title: "Готово" } });
    const st = movingStand(rawCard(), after, READY_COLUMN_ID);
    try {
      expect(await output([SELECTOR], st.io)).toStrictEqual(
        `ok close: поля [—]\nok: Проекты · Бэклог · Разработка → ` +
          `Проекты · Готово · Разработка · ${st.baseUrl}/${CARD_ID}\n`,
      );
      expect(calls(st.seen)).toStrictEqual([
        `GET ${CARD_PATH}`,
        `GET ${COLUMNS_PATH}`,
        `PATCH ${CARD_PATH}`,
        `GET ${CARD_PATH}`,
      ]);
      expect(bodies(st.seen)).toStrictEqual([{ column_id: READY_COLUMN_ID }]);
      const rows = moveRows(st);
      expect(rows.length).toBe(1);
      expect(rows[0].card_id).toStrictEqual(CARD_ID);
      expect(rows[0].to_column).toBe("Готово");
      expect(rows[0].from_column).toBe("Бэклог");
      expect(rows[0].lane).toBe("Разработка");
      expect(rows[0].board).toBe("Проекты");
      expect(rows[0].note).toBe("");
      expect(rows[0].url).toStrictEqual(`${st.baseUrl}/${CARD_ID}`);
    } finally {
      await st.stop();
    }
  });

  it("карточка уже в целевой колонке — релог двумя PATCH", async () => {
    const card = rawCard({
      column: { id: READY_COLUMN_ID, title: "Готово" },
    });
    const st = movingStand(card, card, READY_COLUMN_ID);
    try {
      expect(await output([SELECTOR], st.io)).toContain(
        `Проекты · Готово · Разработка (релог) · ${st.baseUrl}/${CARD_ID}\n`,
      );
      // Сосед — предыдущая колонка по sort_order, а не по порядку ответа.
      expect(bodies(st.seen)).toStrictEqual([
        { column_id: 5000003 },
        { column_id: READY_COLUMN_ID },
      ]);
    } finally {
      await st.stop();
    }
  });

  it("крайняя левая цель — сосед справа", async () => {
    const card = rawCard({
      column: { id: CURRENT_COLUMN_ID, title: "Бэклог" },
    });
    const st = movingStand(card, card, CURRENT_COLUMN_ID);
    try {
      await output([SELECTOR, "--column", "Бэклог"], st.io);
      expect(bodies(st.seen)).toStrictEqual([
        { column_id: 5000003 },
        { column_id: CURRENT_COLUMN_ID },
      ]);
    } finally {
      await st.stop();
    }
  });

  it("релог на доске с одной колонкой — exit 2", async () => {
    const card = rawCard({ column: { id: READY_COLUMN_ID, title: "Готово" } });
    const st = stand({
      [`GET ${CARD_PATH}`]: () => Response.json(card),
      [`GET ${COLUMNS_PATH}`]: () => Response.json([COLUMNS[0]]),
    });
    try {
      const err = await rejected(
        () => kitenCloseCommand.invoke([SELECTOR], st.io),
        UsageError,
      );
      expect(err.message).toBe("на доске одна колонка — релог невозможен");
      expect(calls(st.seen)).toStrictEqual([
        `GET ${CARD_PATH}`,
        `GET ${COLUMNS_PATH}`,
      ]);
    } finally {
      await st.stop();
    }
  });

  it("колонка из env-файла", async () => {
    const after = rawCard({ column: { id: 5000003, title: "В работе" } });
    const st = movingStand(rawCard(), after, 5000003, {
      KITEN_READY_COLUMN: "В работе",
    });
    try {
      await output([SELECTOR], st.io);
      expect(bodies(st.seen)).toStrictEqual([{ column_id: 5000003 }]);
    } finally {
      await st.stop();
    }
  });

  it("--no-move: ни PATCH, ни строки журнала", async () => {
    const st = cardStand(rawCard());
    try {
      await output([SELECTOR, "--no-move"], st.io);
      expect(calls(st.seen)).toStrictEqual([`GET ${CARD_PATH}`]);
      // Кэш-БД не открывалась вовсе: журнал пополняет только перенос.
      expect(moveRows(st).length).toBe(0);
    } finally {
      await st.stop();
    }
  });
});

describe("close: ошибки ввода — до первой мутации", () => {
  it("оба источника ответа — голден текста", async () => {
    const st = stand({});
    try {
      const err = await rejected(() =>
        kitenCloseCommand.invoke(
          [SELECTOR, "--reply", "текст", "--reply-file", "x.md"],
          st.io,
        ), UsageError);
      expect(`${err.message}\n`).toStrictEqual(
        await golden("err-reply-both-message.txt"),
      );
      expect(calls(st.seen)).toStrictEqual([]);
    } finally {
      await st.stop();
    }
  });

  it("пустой текст ответа — голден текста", async () => {
    const st = stand({});
    try {
      const err = await rejected(() =>
        kitenCloseCommand.invoke(
          [SELECTOR, "--reply", "   "],
          st.io,
        ), UsageError);
      expect(`${err.message}\n`).toStrictEqual(
        await golden("err-reply-empty-message.txt"),
      );
      expect(calls(st.seen)).toStrictEqual([]);
    } finally {
      await st.stop();
    }
  });

  it("нечитаемый --reply-file — префикс причины", async () => {
    const st = stand({});
    try {
      const err = await rejected(() =>
        kitenCloseCommand.invoke(
          [SELECTOR, "--reply-file", "/нет/такого.md"],
          st.io,
        ), UsageError);
      expect(err.message).toContain("не удалось прочитать /нет/такого.md: ");
      expect(calls(st.seen)).toStrictEqual([]);
    } finally {
      await st.stop();
    }
  });

  it("колонка не резолвится — голден и ни одной мутации", async () => {
    const startedAtMs = startedHalfMinuteAgo();
    const st = cardStand(rawCard({ timer: rawTimer(startedAtMs) }));
    try {
      const err = await rejected(() =>
        kitenCloseCommand.invoke([
          SELECTOR,
          "--column",
          "Такой колонки нет",
          "--done",
          "Починили",
          "--reply",
          "готово",
          "--stop-timer",
        ], st.io), UsageError);
      expect(`${err.message}\n`).toStrictEqual(
        await golden("err-column-unresolved-message.txt"),
      );
      // Резолв идёт сразу за стартовым чтением: ни таймер, ни поля, ни
      // ответ к этому моменту не тронуты (`kiten-close.md`, вердикт fix).
      expect(calls(st.seen)).toStrictEqual([
        `GET ${CARD_PATH}`,
        `GET ${COLUMNS_PATH}`,
      ]);
    } finally {
      await st.stop();
    }
  });

  it("числовая колонка чужой доски — тот же отказ", async () => {
    const st = cardStand(rawCard());
    try {
      const err = await rejected(() =>
        kitenCloseCommand.invoke(
          [SELECTOR, "--column", "999"],
          st.io,
        ), UsageError);
      expect(err.message).toBe(
        "column '999' не найден — см. `mpu kiten columns`",
      );
    } finally {
      await st.stop();
    }
  });

  it("неоднозначная колонка — кандидаты списком", async () => {
    const st = cardStand(rawCard());
    try {
      const err = await rejected(() =>
        kitenCloseCommand.invoke(
          [SELECTOR, "--column", "о"],
          st.io,
        ), UsageError);
      expect(err.message).toContain("column 'о' неоднозначен (3 совпадений):");
    } finally {
      await st.stop();
    }
  });

  it("числовая колонка своей доски — резолв без поиска", async () => {
    const after = rawCard({ column: { id: 5000003, title: "В работе" } });
    const st = movingStand(rawCard(), after, 5000003);
    try {
      await output([SELECTOR, "--column", "5000003"], st.io);
      expect(bodies(st.seen)).toStrictEqual([{ column_id: 5000003 }]);
    } finally {
      await st.stop();
    }
  });

  it("у карточки нет доски — переносить некуда", async () => {
    const st = cardStand(rawCard({ board: null }));
    try {
      const err = await rejected(
        () => kitenCloseCommand.invoke([SELECTOR], st.io),
        DomainError,
      );
      expect(err.message).toBe("у карточки нет доски — переносить некуда");
      expect(calls(st.seen)).toStrictEqual([`GET ${CARD_PATH}`]);
    } finally {
      await st.stop();
    }
  });

  it("колонки доски не прочитались — отказ API", async () => {
    const st = stand({
      [`GET ${CARD_PATH}`]: () => Response.json(rawCard()),
      [`GET ${COLUMNS_PATH}`]: () => new Response("boom", { status: 500 }),
    });
    try {
      const err = await rejected(
        () => kitenCloseCommand.invoke([SELECTOR], st.io),
        DomainError,
      );
      expect(err.message).toContain("kaiten error: ");
    } finally {
      await st.stop();
    }
  });

  it("селектор без числового сегмента", async () => {
    const st = stand({});
    try {
      await expect(kitenCloseCommand.invoke(["abc"], st.io)).rejects.toThrow(
        UsageError,
      );
      expect(calls(st.seen)).toStrictEqual([]);
    } finally {
      await st.stop();
    }
  });
});

describe("close: отказ шага назван в тексте ошибки", () => {
  const failure = () => new Response("boom", { status: 500 });

  it("стартовое чтение — без маркера шага", async () => {
    const st = stand({ [`GET ${CARD_PATH}`]: failure });
    try {
      const err = await rejected(
        () => kitenCloseCommand.invoke([SELECTOR, "--no-move"], st.io),
        DomainError,
      );
      expect(err.message).toContain("kaiten error: ");
      expect(err.message.includes("(")).toBe(false);
    } finally {
      await st.stop();
    }
  });

  it("таймер — маркер (таймер)", async () => {
    const startedAtMs = startedHalfMinuteAgo();
    const st = cardStand(rawCard({ timer: rawTimer(startedAtMs) }), {
      [`GET ${ROLES_PATH}`]: () => Response.json([]),
      [`PATCH ${TIMER_PATH}`]: failure,
    });
    try {
      const err = await rejected(() =>
        kitenCloseCommand.invoke(
          [SELECTOR, "--no-move", "--stop-timer"],
          st.io,
        ), DomainError);
      expect(err.message).toContain("kaiten error (таймер): ");
    } finally {
      await st.stop();
    }
  });

  it("поля — маркер (поля), таймер уже остановлен", async () => {
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
      const err = await rejected(() =>
        kitenCloseCommand.invoke([
          SELECTOR,
          "--no-move",
          "--stop-timer",
          "--done",
          "Починили",
        ], st.io), DomainError);
      expect(err.message).toContain("kaiten error (поля): ");
      // Ранние шаги остаются применёнными: сквозного отката нет.
      expect(calls(st.seen).includes(`PATCH ${TIMER_PATH}`)).toBe(true);
    } finally {
      await st.stop();
    }
  });

  it("ответ — маркер (ответ), поля уже записаны", async () => {
    const st = cardStand(rawCard(), {
      [`PATCH ${CARD_PATH}`]: () => Response.json(rawCard()),
      [`POST ${COMMENTS_PATH}`]: failure,
    });
    try {
      const err = await rejected(() =>
        kitenCloseCommand.invoke([
          SELECTOR,
          "--no-move",
          "--done",
          "Починили",
          "--reply",
          "готово",
        ], st.io), DomainError);
      expect(err.message).toContain("kaiten error (ответ): ");
      expect(calls(st.seen)).toStrictEqual([
        `GET ${CARD_PATH}`,
        `PATCH ${CARD_PATH}`,
        `POST ${COMMENTS_PATH}`,
      ]);
    } finally {
      await st.stop();
    }
  });

  it("перенос — формат move, без маркера и без журнала", async () => {
    const st = cardStand(rawCard(), { [`PATCH ${CARD_PATH}`]: failure });
    try {
      const err = await rejected(
        () => kitenCloseCommand.invoke([SELECTOR], st.io),
        DomainError,
      );
      expect(err.message).toContain("kaiten error: ");
      expect(moveRows(st).length).toBe(0);
    } finally {
      await st.stop();
    }
  });
});

it("close: ненастроенный KITEN_API_KEY — ошибка ввода", async () => {
  const io = makeFakeIo({
    envFile: {
      get: () => undefined,
      values: () => ({}),
      require: () => "",
      set: () => Promise.resolve(),
    },
  });
  await expect(kitenCloseCommand.invoke([SELECTOR], io)).rejects.toThrow(
    UsageError,
  );
});
