/**
 * `mpu kiten status` (`docs/specs/kiten-status.md`): вся моя работа в
 * Kaiten одной выдачей — назначенное, списанное время и лента действий,
 * слитые в строки, отфильтрованные и напечатанные в одной из пяти форм.
 *
 * Сети в тестах нет ни для одного из шести вызовов сбора
 * (`StatusApi.cardsOfMember/cardsOfResponsible/timeLogs/activities/
 * commentsOf/columnsOf`) — они подставляются через `options.api`
 * целиком. `getCurrentUser` в `StatusApi` не входит (шаг 1 команды зовёт
 * его напрямую от `access`, см. `cmd_status.ts`) — для него поднят
 * настоящий, но локальный HTTP-стенд, отвечающий только на
 * `/api/latest/users/current`. Это расхождение с «сети быть не
 * должно» — часть находки, а не обход требования: без стенда
 * `runKitenStatus` в принципе не запустить (см. итоговый отчёт).
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { CommandIo } from "../command/mod.ts";
import { UsageError } from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { startFakeKaiten } from "../kaiten/testing.ts";
import type {
  Activity,
  CardSummary,
  TimeLogCard,
  UserTimeLog,
} from "../kaiten/mod.ts";
import {
  type KitenStatusArgs,
  renderStatus,
  runKitenStatus,
  type StatusOptions,
} from "./cmd_status.ts";
import type { StatusApi } from "./status_fetch.ts";

const USER_PATH = "/api/latest/users/current";
const NOW = Math.floor(Date.parse("2026-08-19T12:00:00Z") / 1000);

/** Полный набор аргументов команды: дефолты плюс точечные подмены теста. */
function argsOf(overrides: Partial<KitenStatusArgs> = {}): KitenStatusArgs {
  return {
    since: "7d",
    "time-since": "365d",
    out: "matrix",
    stage: undefined,
    board: undefined,
    source: undefined,
    only: undefined,
    format: undefined,
    ...overrides,
  };
}

/** Шесть вызовов сбора: по умолчанию каждый источник пуст. */
function api(overrides: Partial<StatusApi> = {}): Partial<StatusApi> {
  return {
    cardsOfMember: () => Promise.resolve([]),
    cardsOfResponsible: () => Promise.resolve([]),
    timeLogs: () => Promise.resolve([]),
    activities: () => Promise.resolve([]),
    commentsOf: () => Promise.resolve([]),
    columnsOf: () => Promise.resolve([]),
    ...overrides,
  };
}

/** Карточка ответа `/cards` (источники `assigned`/`activity`). */
function cardSummary(overrides: Partial<CardSummary> = {}): CardSummary {
  return {
    id: 1,
    title: "Карточка",
    state: 2,
    condition: 1,
    dueDate: null,
    updated: "2026-08-18T09:00:00Z",
    boardId: 10,
    columnId: 100,
    laneId: 20,
    archived: false,
    lastMovedAt: null,
    timeSpentSum: null,
    boardTitle: "Доска",
    spaceTitles: ["Пространство"],
    columnTitle: "Колонка",
    laneTitle: "Дорожка",
    typeName: null,
    ...overrides,
  };
}

/** Усечённая карточка записи времени (источник `time`). */
function timeLogCard(overrides: Partial<TimeLogCard> = {}): TimeLogCard {
  return {
    id: 1,
    title: "Карточка",
    state: 2,
    condition: 1,
    dueDate: null,
    updated: "2026-08-18T09:00:00Z",
    boardId: 10,
    columnId: 100,
    laneId: 20,
    archived: false,
    lastMovedAt: null,
    timeSpentSum: null,
    boardTitle: "Доска",
    spaceTitle: "Пространство",
    columnTitle: "Колонка",
    laneTitle: "Дорожка",
    typeName: null,
    ...overrides,
  };
}

/** Запись времени с усечённой карточкой; `card: null`, если не задана. */
function timeLog(overrides: Partial<UserTimeLog> = {}): UserTimeLog {
  return {
    id: 1,
    cardId: 1,
    userId: 1,
    authorId: 1,
    roleId: null,
    roleName: null,
    userName: null,
    timeSpent: 30,
    forDate: "2026-08-18",
    comment: "",
    card: null,
    ...overrides,
  };
}

/** Событие ленты действий. */
function activity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: "a1",
    created: "2026-08-18T10:00:00Z",
    action: "card_move",
    cardId: 1,
    card: null,
    ...overrides,
  };
}

interface Stand {
  readonly io: CommandIo;
  readonly baseUrl: string;
  readonly warnings: string[];
  readonly stop: () => Promise<void>;
}

/**
 * Стенд: фейковый Kaiten, отвечающий только `/users/current` (шаг 1,
 * вне `StatusApi`), настоящая кэш-БД во временном каталоге, уже
 * забутстрапленная — `columnTitlesFor` читает её схему безусловно, даже
 * когда недостающих названий нет.
 */
function stand(
  options: {
    readonly userId?: number;
    readonly env?: Record<string, string>;
    /** Доски в кэше справочника: по ним резолвится `--board` (REF). */
    readonly boards?: readonly {
      readonly id: number;
      readonly title: string;
    }[];
  } = {},
): Stand {
  const userId = options.userId ?? 9001;
  const fake = startFakeKaiten((seen) => {
    const last = seen[seen.length - 1];
    if (last.pathname === USER_PATH) {
      return Response.json({
        id: userId,
        full_name: "Тест Тестов",
        username: "tester",
        email: "tester@example.com",
      });
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
  {
    using seed = openCacheDb(`${dir}/cache.db`);
    seed.bootstrap();
    for (const board of options.boards ?? []) {
      seed.execute(
        "INSERT INTO kaiten_boards (id, space_id, title, discovered_at)" +
          " VALUES (?, 1, ?, 0)",
        board.id,
        board.title,
      );
    }
  }
  const io = makeFakeIo({
    envFile: {
      get: (name) => values[name],
      values: () => values,
      require: (name) => values[name] ?? "",
      set: () => Promise.resolve(),
    },
    progress: (line) => void warnings.push(line),
    openCacheDb: () => openCacheDb(`${dir}/cache.db`),
  });
  return {
    io,
    baseUrl: fake.baseUrl,
    warnings,
    stop: async () => {
      await fake.stop();
      Deno.removeSync(dir, { recursive: true });
    },
  };
}

/** Прогон команды: сбор и рендер одной формы. */
async function run(
  st: Stand,
  args: Partial<KitenStatusArgs>,
  options: StatusOptions = {},
): Promise<string> {
  const result = await runKitenStatus(argsOf(args), st.io, {
    nowSeconds: () => NOW,
    ...options,
  });
  return renderStatus(result);
}

function golden(name: string): Promise<string> {
  return Deno.readTextFile(
    new URL(`testdata/kiten-status/${name}`, import.meta.url),
  );
}

// ---------------------------------------------------------------------
// 1 (регистрация копий фикстур) — `fixtures_test.ts`.
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// 2. `--out json` — байт-в-байт с `status.json`.
// ---------------------------------------------------------------------

Deno.test("json: совпадает с голденом за вычетом фикстурного дефекта", async () => {
  // Нормализация голдена подменила `column` одинаковой синтетикой
  // («Колонка 1») у всех трёх карточек, но оставила `stage` как в живом
  // прогоне — а `stage` в коде считается ЧИСТОЙ функцией от `column`
  // (`mergeInputs` → `stageOf`). Три строки с байт-в-байт одинаковым
  // `column`, но разным `stage`, поэтому через настоящий алгоритм
  // недостижимы ни при каком подставном входе и ни при какой карте
  // `KITEN_STAGE_MAP` — это артефакт анонимизации голдена, а не дефект
  // кода (см. итоговый отчёт). Карточки 1–2 воспроизводятся точно через
  // `KITEN_STAGE_MAP`; карточка 3 получает то же самое различие в
  // единственном месте, где оно физически возможно, — тексте `column`.
  const st = stand({
    env: { KITEN_STAGE_MAP: '{"Колонка 1":"review"}' },
  });
  try {
    const common = {
      state: 2,
      condition: 1,
      archived: false,
      boardTitle: "Доска 1",
      spaceTitles: ["Пространство 1"],
      laneTitle: "Дорожка 1",
    };
    const card1 = cardSummary({
      ...common,
      id: 68000001,
      title: "Тестовая карточка один",
      columnTitle: "Колонка 1",
      dueDate: "2026-08-19T00:00:00.000Z",
      updated: "2026-08-19T08:51:41.025Z",
    });
    const card2 = cardSummary({
      ...common,
      id: 68000002,
      title: "Тестовая карточка два",
      columnTitle: "Колонка 1",
      dueDate: "2026-08-19T00:00:00.000Z",
      updated: "2026-08-19T08:51:41.025Z",
    });
    const card3 = cardSummary({
      ...common,
      id: 68000003,
      title: "Тестовая карточка три",
      // Естественная подстрока «очеред» — без карты стадия сама
      // выходит «Очередь»; `column` в выдаче честно покажет этот текст,
      // а не голденовскую синтетику (см. пояснение выше).
      columnTitle: "Очередь",
      dueDate: "2026-09-01T12:00:00.000Z",
      updated: "2026-08-17T06:11:35.621Z",
    });
    const text = await run(st, { out: "json" }, {
      api: api({
        // Карточка 3 умышленно не назначена — её единственный источник
        // «activity», как в голдене (`sources: ["activity"]`).
        cardsOfMember: () => Promise.resolve([card1, card2]),
        activities: () =>
          Promise.resolve([
            activity({ id: "e1", cardId: 68000001, card: card1 }),
            activity({ id: "e2", cardId: 68000002, card: card2 }),
            activity({ id: "e3", cardId: 68000003, card: card3 }),
          ]),
      }),
    });
    const raw = await golden("status.json");
    const marker = '"column": "Колонка 1",';
    const lastAt = raw.lastIndexOf(marker);
    const expected = `${raw.slice(0, lastAt)}"column": "Очередь",${
      raw.slice(lastAt + marker.length)
    }`.replaceAll("https://btlz.kaiten.ru", st.baseUrl);
    assertEquals(text, expected);
  } finally {
    await st.stop();
  }
});

// ---------------------------------------------------------------------
// 3. `--out md` — байт-в-байт с `status.md`.
// ---------------------------------------------------------------------

Deno.test("md: совпадает с голденом status.md байт-в-байт", async () => {
  const st = stand();
  try {
    const common = {
      state: 2,
      condition: 1,
      archived: false,
      boardTitle: "Доска 1",
      spaceTitles: ["Пространство 1"],
      laneTitle: "Дорожка 1",
    };
    const card1 = cardSummary({
      ...common,
      id: 68000001,
      title: "Тестовая карточка один",
      columnTitle: "Ревью",
      updated: "2026-08-19T10:00:00Z",
    });
    const card2 = cardSummary({
      ...common,
      id: 68000002,
      title: "Тестовая карточка два",
      columnTitle: "Ревью",
      updated: "2026-08-19T09:00:00Z",
    });
    const card3 = cardSummary({
      ...common,
      id: 68000003,
      title: "Тестовая карточка три",
      columnTitle: "Очередь",
      updated: "2026-08-19T08:00:00Z",
    });
    const text = await run(st, { out: "md" }, {
      api: api({
        cardsOfMember: () => Promise.resolve([card1, card2, card3]),
      }),
    });
    assertEquals(text, await golden("status.md"));
  } finally {
    await st.stop();
  }
});

// ---------------------------------------------------------------------
// 4. Формы: url, format, matrix/group (пусто и непусто).
// ---------------------------------------------------------------------

Deno.test("url: скобки в title экранируются", async () => {
  const st = stand();
  try {
    const card = cardSummary({
      id: 81001,
      title: "Тест [срочно] задача",
    });
    const text = await run(st, { out: "url" }, {
      api: api({ cardsOfMember: () => Promise.resolve([card]) }),
    });
    assertEquals(
      text,
      `[Тест \\[срочно\\] задача](${st.baseUrl}/81001)\n`,
    );
  } finally {
    await st.stop();
  }
});

Deno.test("format: нумерация с 1, {src} через запятую, неизвестный плейсхолдер как есть", async () => {
  const st = stand();
  try {
    const card1 = cardSummary({
      id: 71001,
      title: "Карточка раз",
      dueDate: "2026-08-20T00:00:00Z",
    });
    const card2 = cardSummary({ id: 71002, title: "Карточка два" });
    const text = await run(st, { format: "{n}:{id}:{src}:{due}:{missing}" }, {
      api: api({
        cardsOfMember: () => Promise.resolve([card1]),
        activities: () =>
          Promise.resolve([activity({ cardId: 71002, card: card2 })]),
        timeLogs: () =>
          Promise.resolve([
            timeLog({
              cardId: 71001,
              forDate: "2026-08-18",
              timeSpent: 15,
              card: timeLogCard({ id: 71001 }),
            }),
          ]),
      }),
    });
    assertEquals(
      text,
      "1:71001:assigned,time:2026-08-20:{missing}\n" +
        "2:71002:activity::{missing}\n",
    );
  } finally {
    await st.stop();
  }
});

Deno.test("matrix/group: непусто содержит id карточек, пусто — ровно «(нет карточек)»", async (t) => {
  const st = stand();
  try {
    const card1 = cardSummary({
      id: 91001,
      title: "Раз",
      columnTitle: "В работе",
    });
    const card2 = cardSummary({
      id: 91002,
      title: "Два",
      columnTitle: "Готово",
      state: 3,
    });
    const withCards = api({
      cardsOfMember: () => Promise.resolve([card1, card2]),
    });

    await t.step("matrix непустая", async () => {
      const text = await run(st, { out: "matrix" }, { api: withCards });
      assertStringIncludes(text, "91001");
      assertStringIncludes(text, "91002");
    });

    await t.step("group непустая", async () => {
      const text = await run(st, { out: "group" }, { api: withCards });
      assertStringIncludes(text, "91001");
      assertStringIncludes(text, "91002");
    });

    await t.step("matrix пустая", async () => {
      const text = await run(st, { out: "matrix" }, { api: api() });
      assertEquals(text, "(нет карточек)\n");
    });

    await t.step("group пустая", async () => {
      const text = await run(st, { out: "group" }, { api: api() });
      assertEquals(text, "(нет карточек)\n");
    });
  } finally {
    await st.stop();
  }
});

// ---------------------------------------------------------------------
// 5. Машинные формы не печатают подвал и рамки.
// ---------------------------------------------------------------------

Deno.test("json/md/url/format: без подвала и рамок", async (t) => {
  const st = stand();
  try {
    const card1 = cardSummary({ id: 61001, title: "Раз" });
    const card2 = cardSummary({ id: 61002, title: "Два", state: 3 });
    const withCards = api({
      cardsOfMember: () => Promise.resolve([card1, card2]),
    });
    const footerHints = ["карточек (", "время за окно:", "только из ленты:"];

    for (const out of ["json", "md", "url"] as const) {
      await t.step(`--out ${out}`, async () => {
        const text = await run(st, { out }, { api: withCards });
        for (const hint of footerHints) {
          assertEquals(text.includes(hint), false, `нашёлся «${hint}»`);
        }
      });
    }

    await t.step("--format", async () => {
      const text = await run(st, { format: "{id}" }, { api: withCards });
      for (const hint of footerHints) {
        assertEquals(text.includes(hint), false, `нашёлся «${hint}»`);
      }
    });
  } finally {
    await st.stop();
  }
});

// ---------------------------------------------------------------------
// 6. Фильтры: --stage, --board, --source (включая touch), --only.
// ---------------------------------------------------------------------

Deno.test("фильтры: stage/board/source/only сужают выдачу независимо", async (t) => {
  // Доска в кэше справочника: по нему резолвится `--board` (REF).
  const st = stand({ boards: [{ id: 701, title: "Alpha" }] });
  try {
    const common = {
      state: 2,
      condition: 1,
      archived: false,
      spaceTitles: ["S"],
      updated: "2026-08-18T00:00:00Z",
    };
    // A — назначена, «В работе», доска Alpha.
    const a = cardSummary({
      ...common,
      id: 51001,
      title: "A",
      boardTitle: "Alpha",
      columnTitle: "Разработка",
    });
    // B — время, «Тест», доска Beta.
    const b = timeLogCard({
      id: 51002,
      title: "B",
      state: 2,
      condition: 1,
      archived: false,
      boardTitle: "Beta",
      columnTitle: "Тестирование",
      spaceTitle: "S",
      updated: "2026-08-18T00:00:00Z",
    });
    // C — только лента (touch), «Очередь», доска Alpha.
    const c = cardSummary({
      ...common,
      id: 51003,
      title: "C",
      boardTitle: "Alpha",
      columnTitle: "Очередь",
    });
    // D — назначена, завершена (state=done), «Готово», доска Beta.
    const d = cardSummary({
      ...common,
      id: 51004,
      title: "D",
      boardTitle: "Beta",
      columnTitle: "Готово",
      state: 3,
    });
    // E — только лента (touch), в архиве, «Ревью», доска Gamma.
    const e = cardSummary({
      ...common,
      id: 51005,
      title: "E",
      boardTitle: "Gamma",
      columnTitle: "Ревью",
      condition: 2,
      archived: true,
    });

    const dataset = api({
      cardsOfMember: () => Promise.resolve([a, d]),
      timeLogs: () =>
        Promise.resolve([
          timeLog({
            cardId: 51002,
            forDate: "2026-08-18",
            timeSpent: 60,
            card: b,
          }),
        ]),
      activities: () =>
        Promise.resolve([
          activity({ id: "ec", cardId: 51003, card: c }),
          activity({ id: "ee", cardId: 51005, card: e }),
        ]),
    });

    const ids = async (overrides: Partial<KitenStatusArgs>) => {
      const result = await runKitenStatus(
        argsOf({ out: "json", ...overrides }),
        st.io,
        {
          api: dataset,
          nowSeconds: () => NOW,
        },
      );
      return result.rows.map((row) => row.id).sort((x, y) => x - y);
    };

    await t.step("--stage work", async () => {
      assertEquals(await ids({ stage: "work" }), [51001]);
    });

    await t.step("--stage done", async () => {
      assertEquals(await ids({ stage: "done" }), [51004]);
    });

    await t.step("--board точным именем", async () => {
      assertEquals(await ids({ board: "Alpha" }), [51001, 51003]);
    });

    await t.step("--board подстрокой названия", async () => {
      // `--board` — это REF: он резолвится по кэшу справочника, а не
      // сравнивается с названием доски буквально (спека, «CLI-контракт»).
      assertEquals(await ids({ board: "Alph" }), [51001, 51003]);
    });

    await t.step("--board идентификатором доски", async () => {
      assertEquals(await ids({ board: "701" }), [51001, 51003]);
    });

    await t.step("--source assigned", async () => {
      assertEquals(await ids({ source: "assigned" }), [51001, 51004]);
    });

    await t.step("--source time", async () => {
      assertEquals(await ids({ source: "time" }), [51002]);
    });

    await t.step("--source touch", async () => {
      assertEquals(await ids({ source: "touch" }), [51003, 51005]);
    });

    await t.step("--only open", async () => {
      assertEquals(await ids({ only: "open" }), [51001, 51002, 51003]);
    });

    await t.step("--only done", async () => {
      assertEquals(await ids({ only: "done" }), [51004, 51005]);
    });
  } finally {
    await st.stop();
  }
});

// ---------------------------------------------------------------------
// 7. Два окна независимы: ВРЕМЯ — за --time-since, попадание — за --since.
// ---------------------------------------------------------------------

Deno.test("окна независимы: минуты за --time-since, источник time — за --since", async () => {
  const st = stand();
  try {
    // Живая карточка — попадает в выдачу независимо от окон (alive).
    const card = cardSummary({
      id: 41001,
      title: "X",
      columnTitle: "Разработка",
      updated: "2026-08-01T00:00:00Z",
    });
    // Запись времени старше начала окна `--since` (по умолчанию 7d —
    // граница около 2026-08-12), но много новее начала `--time-since`
    // (365d): сумма минут её учитывает, а источником `time` карточка не
    // становится (спека, шаг 3).
    const oldLog = timeLog({
      cardId: 41001,
      forDate: "2026-07-01",
      timeSpent: 90,
      card: null,
    });
    const result = await runKitenStatus(argsOf({ out: "json" }), st.io, {
      api: api({
        cardsOfMember: () => Promise.resolve([card]),
        timeLogs: () => Promise.resolve([oldLog]),
      }),
      nowSeconds: () => NOW,
    });
    assertEquals(result.rows.length, 1);
    assertEquals(result.rows[0].my_minutes, 90);
    assertEquals(result.rows[0].sources, ["assigned"]);
  } finally {
    await st.stop();
  }
});

// ---------------------------------------------------------------------
// 8. Предупреждение о неполной ленте — в progress при любой форме.
// ---------------------------------------------------------------------

Deno.test("неполная лента: предупреждение в progress при любой форме вывода", async (t) => {
  const st = stand();
  try {
    // Единственное прочитанное событие новее начала окна `--since» —
    // лента прочитана не до конца. `card: null` — строку не создаёт
    // (событие без вложенной карточки), но `oldestFeedAt` всё равно
    // считается: предупреждение не зависит от того, породило ли событие
    // строку.
    const withApi = api({
      activities: () =>
        Promise.resolve([
          activity({
            id: "recent",
            created: "2026-08-18T10:00:00Z",
            cardId: null,
            card: null,
          }),
        ]),
    });
    const expected = "mpu kiten status: лента действий прочитана только до " +
      "2026-08-18 (предел 3 страниц); карточки, которые я лишь " +
      "комментировал раньше этой даты, могли не попасть в выдачу";

    for (const out of ["matrix", "group", "json", "md", "url"] as const) {
      await t.step(`--out ${out}`, async () => {
        st.warnings.length = 0;
        await run(st, { out }, { api: withApi });
        assertEquals(st.warnings, [expected]);
      });
    }

    await t.step("--format", async () => {
      st.warnings.length = 0;
      await run(st, { format: "{id}" }, { api: withApi });
      assertEquals(st.warnings, [expected]);
    });
  } finally {
    await st.stop();
  }
});

// ---------------------------------------------------------------------
// 9. Ошибки ввода — UsageError (exit 2), текст ровно как в спеке.
// ---------------------------------------------------------------------

Deno.test("ошибки ввода: --since/--time-since/--stage — UsageError с текстом спеки", async (t) => {
  // Разбор аргументов происходит до всякого обращения к Kaiten и
  // кэш-БД (`runKitenStatus`: `windowOf`/`stageArg` — раньше
  // `kaitenAccess`/`getCurrentUser`), поэтому фейковый io без единого
  // разрешённого обращения годится: тронь команда сеть или диск на этом
  // шаге — тест покраснеет.
  const io = makeFakeIo();

  await t.step("--since невалиден", async () => {
    const err = await assertRejects(
      () =>
        runKitenStatus(argsOf({ since: "abc" }), io, { nowSeconds: () => NOW }),
      UsageError,
    );
    assertEquals(
      (err as UsageError).message,
      "--since: ожидается <число>{s|m|h|d} или unix-ts, получено 'abc'",
    );
  });

  await t.step("--time-since невалиден", async () => {
    const err = await assertRejects(
      () =>
        runKitenStatus(argsOf({ "time-since": "??" }), io, {
          nowSeconds: () => NOW,
        }),
      UsageError,
    );
    assertEquals(
      (err as UsageError).message,
      "--time-since: ожидается <число>{s|m|h|d} или unix-ts, получено '??'",
    );
  });

  await t.step("--stage неизвестен", async () => {
    const err = await assertRejects(
      () =>
        runKitenStatus(argsOf({ stage: "bogus" }), io, {
          nowSeconds: () => NOW,
        }),
      UsageError,
    );
    assertEquals(
      (err as UsageError).message,
      "неизвестный этап 'bogus'; допустимо: queue, estimate, work, review, " +
        "test, dev, preprod, done",
    );
  });
});

// ---------------------------------------------------------------------
// 10. KITEN_STAGE_MAP: битый JSON, не-объект — предупреждение, не отказ;
//     корректная карта перекрывает правило этапа.
// ---------------------------------------------------------------------

Deno.test("KITEN_STAGE_MAP: битый JSON — предупреждение, команда работает", async () => {
  const st = stand({ env: { KITEN_STAGE_MAP: "{not json" } });
  try {
    const text = await run(st, { out: "json" }, { api: api() });
    assertEquals(text, "[]\n");
    assertEquals(st.warnings.length, 1);
    assertStringIncludes(
      st.warnings[0],
      "mpu kiten status: некорректный JSON в KITEN_STAGE_MAP:",
    );
  } finally {
    await st.stop();
  }
});

Deno.test("KITEN_STAGE_MAP: не объект — предупреждение, команда работает", async () => {
  const st = stand({ env: { KITEN_STAGE_MAP: "[1,2,3]" } });
  try {
    const text = await run(st, { out: "json" }, { api: api() });
    assertEquals(text, "[]\n");
    assertEquals(st.warnings, [
      "mpu kiten status: KITEN_STAGE_MAP должен быть JSON-объектом",
    ]);
  } finally {
    await st.stop();
  }
});

Deno.test("KITEN_STAGE_MAP: корректная карта перекрывает правило этапа своей колонки", async () => {
  const st = stand({
    env: { KITEN_STAGE_MAP: '{"Особая колонка":"review"}' },
  });
  try {
    // Название колонки не подходит ни под одну встроенную подстроку —
    // без карты этап был бы «—».
    const card = cardSummary({
      id: 31001,
      title: "Особая",
      columnTitle: "Особая колонка",
    });
    const result = await runKitenStatus(argsOf({ out: "json" }), st.io, {
      api: api({ cardsOfMember: () => Promise.resolve([card]) }),
      nowSeconds: () => NOW,
    });
    assertEquals(st.warnings, []);
    assertEquals(result.rows.length, 1);
    assertEquals(result.rows[0].stage, "Ревью");
  } finally {
    await st.stop();
  }
});
