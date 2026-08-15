/**
 * Личный таймер — `mpu kiten time start | status | stop | discard`
 * (`docs/specs/kiten-time.md`). Успешные ветви `start`, `status` и
 * `discard` закрыты голденами канала; у `stop` голдена нет — его строка
 * собирается здесь по «CLI-контракту» спеки, и под проверкой отдельно
 * стоит ИСТОЧНИК каждого поля: длительность, дата, роль и id берутся из
 * перечитанной записи и справочника, а не из того, что команда отправила.
 *
 * Три ветви конфликта `start` голденов не имеют намеренно: снятые с
 * рабочей версии файлы — свидетельства отклонений, воспроизводить их
 * запрещено, и целевые тексты взяты из «Граничных случаев» дословно.
 *
 * Часы в голденах `status` подставляются под момент прогона: метка
 * старта у фейка живая, иначе натёкшая длительность зависела бы от даты
 * запуска тестов. Сверяется форма строки целиком, включая эту подстановку.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  type Command,
  type CommandIo,
  DomainError,
  formatCommandError,
  UsageError,
} from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { type CapturedRequest, startFakeKaiten } from "../kaiten/testing.ts";
import {
  kitenTimeDiscardCommand,
  kitenTimeStartCommand,
  kitenTimeStatusCommand,
  kitenTimeStopCommand,
} from "./mod.ts";
import { mskClock, mskDay } from "./msk.ts";

const API_KEY = "proba-kaiten-key-Q3z8Nw";
const CARD_ID = 10000001;
const OTHER_CARD_ID = 10000002;
const SELECTOR = String(CARD_ID);
const TIMER_ID = 5000001;
const LOG_ID = 7000001;

const CARD_PATH = `/api/latest/cards/${CARD_ID}`;
const LOGS_PATH = `${CARD_PATH}/time-logs`;
const ROLES_PATH = "/api/latest/user-roles";
const TIMERS_PATH = "/api/latest/user-timers";
const TIMER_PATH = `${TIMERS_PATH}/${TIMER_ID}`;

/** Адрес карточки в голденах: снят с обезличенного живого прогона. */
const GOLDEN_CARD_URL = `https://kaiten.example.test/${CARD_ID}`;

/** Часы старта в голденах: подставляются под момент прогона. */
const GOLDEN_CLOCK = /\d{2}:\d{2} МСК/;

const ROLES = [
  { id: 12058, name: "Техподдержка" },
  { id: 12132, name: "Тестирование" },
];

/** Момент, с которого таймер идёт ровно одну минуту (округление вверх). */
function startedHalfMinuteAgo(): number {
  return Date.now() - 30_000;
}

/** Живой таймер в форме ответа внешней системы. */
function rawTimer(
  patch: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: TIMER_ID,
    card_id: CARD_ID,
    card_title: "Проба таймера",
    comment: "",
    started_at: new Date(startedHalfMinuteAgo()).toISOString(),
    finished_at: null,
    card_time_log_id: null,
    ...patch,
  };
}

/** Полная карточка в форме ответа внешней системы. */
function rawCard(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CARD_ID,
    title: "Проба таймера",
    time_spent_sum: 0,
    timer: null,
    ...patch,
  };
}

/** Ответ создания записи: названия роли в нём нет, только `role_id`. */
function rawMutationLog(
  patch: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: LOG_ID,
    card_id: CARD_ID,
    user_id: 900001,
    author_id: 900001,
    role_id: 12058,
    time_spent: 75,
    // День записи совпадает с московским днём финиша: иначе сработало бы
    // предупреждение о сдвинутом дне, и оно проверяется отдельным шагом.
    for_date: mskDay(),
    comment: "",
    ...patch,
  };
}

function golden(name: string): Promise<string> {
  return Deno.readTextFile(
    new URL(`testdata/kiten-time/${name}`, import.meta.url),
  );
}

/** Голден под стенд: свой базовый URL и часы момента прогона. */
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
    : text.replace(GOLDEN_CLOCK, `${mskClock(startedAtMs)} МСК`);
}

/** Чем отвечать на «МЕТОД путь»; пара вне таблицы — красный тест. */
type Routes = Readonly<Record<string, () => Response | Promise<Response>>>;

interface Stand {
  readonly io: CommandIo;
  readonly baseUrl: string;
  readonly seen: readonly CapturedRequest[];
  readonly notes: readonly string[];
  readonly stop: () => Promise<void>;
}

function stand(
  routes: Routes,
  extraEnv: Readonly<Record<string, string>> = {},
): Stand {
  const notes: string[] = [];
  const fake = startFakeKaiten((seen) => {
    const last = seen[seen.length - 1];
    const route = routes[`${last.method} ${last.pathname}`];
    return route === undefined
      ? new Response("вызов, которого тест не ждал", { status: 500 })
      : route();
  });
  const values: Readonly<Record<string, string>> = {
    KITEN_API_KEY: API_KEY,
    KITEN_BASE_URL: fake.baseUrl,
    ...extraEnv,
  };
  const io = makeFakeIo({
    envFile: {
      get: (name) => values[name],
      values: () => values,
      require: (name) => values[name] ?? "",
      set: () => Promise.resolve(),
    },
    progress: (line) => void notes.push(line),
  });
  return {
    io,
    baseUrl: fake.baseUrl,
    seen: fake.seen,
    notes,
    stop: fake.stop,
  };
}

/** Текст вывода так, как его напечатает точка входа. */
async function output(
  command: Command,
  argv: readonly string[],
  io: CommandIo,
): Promise<string> {
  return command.renderResult(await command.invoke(argv, io), argv);
}

/** Вызовы в порядке обращения: «МЕТОД путь». */
function calls(seen: readonly CapturedRequest[]): readonly string[] {
  return seen.map((request) => `${request.method} ${request.pathname}`);
}

/** Текст ошибки так, как его напечатает точка входа, с переводом строки. */
async function errorText(
  command: Command,
  argv: readonly string[],
  io: CommandIo,
  kind: typeof UsageError | typeof DomainError,
): Promise<string> {
  const err = await assertRejects(() => command.invoke(argv, io), kind);
  return `${formatCommandError(command.errorName, err)}\n`;
}

/** Конфликт запуска: статус 400 и тело без `id` — как отвечает Kaiten. */
function conflictResponse(): Response {
  return Response.json({ message: "User timer already created" }, {
    status: 400,
  });
}

Deno.test("time start: запуск таймера", async (t) => {
  await t.step("голден строки успеха и состав вызовов", async () => {
    const startedAt = "2026-08-14T19:50:33.000+03:00";
    const { io, baseUrl, seen, stop } = stand({
      [`GET ${CARD_PATH}`]: () => Response.json(rawCard()),
      [`POST ${TIMERS_PATH}`]: () =>
        Response.json(rawTimer({ started_at: startedAt })),
    });
    try {
      assertEquals(
        await output(kitenTimeStartCommand, [SELECTOR, "-m", "разбор"], io),
        await expected("start-stdout.txt", baseUrl),
      );
      // Свежее чтение карточки перед стартом; запрос на старт — ровно один.
      assertEquals(calls(seen), [
        `GET ${CARD_PATH}`,
        `POST ${TIMERS_PATH}`,
      ]);
      assertEquals(JSON.parse(seen[1].body), {
        card_id: CARD_ID,
        comment: "разбор",
      });
    } finally {
      await stop();
    }
  });

  await t.step("без --comment ключа комментария в теле нет", async () => {
    const { io, seen, stop } = stand({
      [`GET ${CARD_PATH}`]: () => Response.json(rawCard()),
      [`POST ${TIMERS_PATH}`]: () => Response.json(rawTimer()),
    });
    try {
      await output(kitenTimeStartCommand, [SELECTOR], io);
      assertEquals(JSON.parse(seen[1].body), { card_id: CARD_ID });
    } finally {
      await stop();
    }
  });

  await t.step("роли у старта нет: --role не принимается", async () => {
    const { io, seen, stop } = stand({});
    try {
      await assertRejects(
        () => kitenTimeStartCommand.invoke([SELECTOR, "--role", "12058"], io),
        UsageError,
      );
      assertEquals(calls(seen), []);
    } finally {
      await stop();
    }
  });

  await t.step("конфликт на той же карточке: два действия", async () => {
    const startedAtMs = startedHalfMinuteAgo();
    const started = new Date(startedAtMs).toISOString();
    const { io, seen, stop } = stand({
      [`GET ${CARD_PATH}`]: () =>
        Response.json(rawCard({ timer: rawTimer({ started_at: started }) })),
      [`POST ${TIMERS_PATH}`]: conflictResponse,
    });
    try {
      assertEquals(
        await errorText(kitenTimeStartCommand, [SELECTOR], io, DomainError),
        `mpu kiten time start: таймер уже идёт на карточке ${CARD_ID} (с ${
          mskClock(startedAtMs)
        } МСК); останови \`mpu kiten time stop ${CARD_ID}\` или сбрось ` +
          `\`mpu kiten time discard ${CARD_ID}\`\n`,
      );
      // Таймер читается ПОСЛЕ конфликта: до него решать было не по чему.
      assertEquals(calls(seen), [
        `GET ${CARD_PATH}`,
        `POST ${TIMERS_PATH}`,
        `GET ${CARD_PATH}`,
      ]);
    } finally {
      await stop();
    }
  });

  await t.step("конфликт на чужой карточке: одно действие", async () => {
    const startedAtMs = startedHalfMinuteAgo();
    const started = new Date(startedAtMs).toISOString();
    const { io, stop } = stand({
      [`GET ${CARD_PATH}`]: () =>
        Response.json(rawCard({
          timer: rawTimer({ card_id: OTHER_CARD_ID, started_at: started }),
        })),
      [`POST ${TIMERS_PATH}`]: conflictResponse,
    });
    try {
      assertEquals(
        await errorText(kitenTimeStartCommand, [SELECTOR], io, DomainError),
        `mpu kiten time start: таймер уже идёт на карточке ${OTHER_CARD_ID} (с ${
          mskClock(startedAtMs)
        } МСК); останови \`mpu kiten time stop ${OTHER_CARD_ID}\`\n`,
      );
    } finally {
      await stop();
    }
  });

  await t.step("конфликт, а таймер не прочитан: без карточки", async () => {
    let asked = 0;
    const { io, stop } = stand({
      [`GET ${CARD_PATH}`]: () =>
        ++asked === 1
          ? Response.json(rawCard())
          : new Response("сервер прилёг", { status: 503 }),
      [`POST ${TIMERS_PATH}`]: conflictResponse,
    });
    try {
      assertEquals(
        await errorText(kitenTimeStartCommand, [SELECTOR], io, DomainError),
        "mpu kiten time start: Kaiten сообщает, что таймер уже создан; " +
          `попробуй: mpu kiten time stop ${CARD_ID}\n`,
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("time status: чтение без мутаций", async (t) => {
  await t.step("голден: таймер не запущен", async () => {
    const { io, baseUrl, seen, stop } = stand({
      [`GET ${CARD_PATH}`]: () => Response.json(rawCard()),
    });
    try {
      assertEquals(
        await output(kitenTimeStatusCommand, [SELECTOR], io),
        await expected("status-idle-stdout.txt", baseUrl),
      );
      assertEquals(calls(seen), [`GET ${CARD_PATH}`]);
    } finally {
      await stop();
    }
  });

  await t.step("голден: таймер идёт", async () => {
    const startedAtMs = startedHalfMinuteAgo();
    const { io, baseUrl, stop } = stand({
      [`GET ${CARD_PATH}`]: () =>
        Response.json(rawCard({
          timer: rawTimer({
            started_at: new Date(startedAtMs).toISOString(),
          }),
        })),
    });
    try {
      assertEquals(
        await output(kitenTimeStatusCommand, [SELECTOR], io),
        await expected("status-running-stdout.txt", baseUrl, startedAtMs),
      );
    } finally {
      await stop();
    }
  });

  await t.step("голден: таймер с комментарием и ненулевой итог", async () => {
    const startedAtMs = startedHalfMinuteAgo();
    const { io, baseUrl, stop } = stand({
      [`GET ${CARD_PATH}`]: () =>
        Response.json(rawCard({
          // Итог по карточке считает записи: идущий таймер в него не входит.
          time_spent_sum: 165,
          timer: rawTimer({
            comment: "проба таймера",
            started_at: new Date(startedAtMs).toISOString(),
          }),
        })),
    });
    try {
      assertEquals(
        await output(kitenTimeStatusCommand, [SELECTOR], io),
        await expected(
          "status-running-comment-stdout.txt",
          baseUrl,
          startedAtMs,
        ),
      );
    } finally {
      await stop();
    }
  });

  await t.step("сервер не назвал сумму — итог ноль", async () => {
    const { io, stop } = stand({
      // Поля `time_spent_sum` в ответе нет вовсе: «нет суммы» и «ноль» для
      // вывода одно и то же.
      [`GET ${CARD_PATH}`]: () =>
        Response.json({ id: CARD_ID, title: "Проба", timer: null }),
    });
    try {
      const text = await output(kitenTimeStatusCommand, [SELECTOR], io);
      assertEquals(text.endsWith("всего по карточке: 0 мин\n"), true);
    } finally {
      await stop();
    }
  });

  await t.step("отказ Kaiten — доменная ошибка, не паника", async () => {
    const { io, stop } = stand({
      [`GET ${CARD_PATH}`]: () => new Response("прилегло", { status: 503 }),
    });
    try {
      const text = await errorText(
        kitenTimeStatusCommand,
        [SELECTOR],
        io,
        DomainError,
      );
      assertEquals(
        text.startsWith("mpu kiten time status: kaiten error: "),
        true,
      );
    } finally {
      await stop();
    }
  });

  await t.step("голден --json: таймера нет", async () => {
    const { io, stop } = stand({
      [`GET ${CARD_PATH}`]: () =>
        Response.json(rawCard({ time_spent_sum: 240 })),
    });
    try {
      assertEquals(
        await output(kitenTimeStatusCommand, [SELECTOR, "--json"], io),
        await golden("status-json-stdout.txt"),
      );
    } finally {
      await stop();
    }
  });
});

Deno.test("time stop: остановка с созданием записи", async (t) => {
  await t.step("четыре вызова, тело запроса и источники полей", async () => {
    const startedAtMs = startedHalfMinuteAgo();
    const started = new Date(startedAtMs).toISOString();
    const { io, baseUrl, seen, stop } = stand({
      [`GET ${CARD_PATH}`]: () =>
        Response.json(rawCard({
          timer: rawTimer({ started_at: started, comment: "разбор жалобы" }),
        })),
      [`GET ${ROLES_PATH}`]: () => Response.json(ROLES),
      [`PATCH ${TIMER_PATH}`]: () =>
        Response.json(rawTimer({ card_time_log_id: LOG_ID })),
      [`GET ${LOGS_PATH}`]: () =>
        Response.json([rawMutationLog({ comment: "разбор жалобы" })]),
    });
    try {
      assertEquals(
        await output(kitenTimeStopCommand, [SELECTOR], io),
        `ok: таймер остановлен · записано 1 ч 15 мин · ${mskDay()} · ` +
          `Техподдержка · запись ${LOG_ID} · ${baseUrl}/${CARD_ID}\n`,
      );
      assertEquals(calls(seen), [
        `GET ${CARD_PATH}`,
        `GET ${ROLES_PATH}`,
        `PATCH ${TIMER_PATH}`,
        `GET ${LOGS_PATH}`,
      ]);
      const body = JSON.parse(seen[2].body);
      // Без --time начало не передаётся: его знает сервер.
      assertEquals(Object.keys(body).sort(), [
        "comment",
        "finished_at",
        "role_id",
      ]);
      // Комментарий таймера сам сервер в запись не переносит.
      assertEquals(body.comment, "разбор жалобы");
      assertEquals(body.role_id, 12058);
      assertEquals(/\.000[+-]\d{2}:\d{2}$/.test(body.finished_at), true);
    } finally {
      await stop();
    }
  });

  await t.step("роль печатается названием из справочника", async () => {
    const { io, stop } = stand({
      [`GET ${CARD_PATH}`]: () => Response.json(rawCard({ timer: rawTimer() })),
      [`GET ${ROLES_PATH}`]: () => Response.json(ROLES),
      [`PATCH ${TIMER_PATH}`]: () =>
        Response.json(rawTimer({ card_time_log_id: LOG_ID })),
      [`GET ${LOGS_PATH}`]: () =>
        Response.json([rawMutationLog({ role_id: 12132 })]),
    }, { KITEN_TIME_ROLE: "Тестирование" });
    try {
      const text = await output(kitenTimeStopCommand, [SELECTOR], io);
      // Ответ остановки и запись названия роли не несут — только role_id.
      assertEquals(text.includes("· Тестирование ·"), true);
      assertEquals(text.includes("12132"), false);
    } finally {
      await stop();
    }
  });

  await t.step("--time меньше факта: границы от старта", async () => {
    // 19,5 минуты назад: округление вверх даёт ровно 20 минут факта и не
    // зависит от того, сколько прогон провёл между вызовами.
    const startedAtMs = Date.now() - 19.5 * 60_000;
    const started = new Date(startedAtMs).toISOString();
    const { io, seen, notes, stop } = stand({
      [`GET ${CARD_PATH}`]: () =>
        Response.json(rawCard({ timer: rawTimer({ started_at: started }) })),
      [`GET ${ROLES_PATH}`]: () => Response.json(ROLES),
      [`PATCH ${TIMER_PATH}`]: () =>
        Response.json(rawTimer({ card_time_log_id: LOG_ID })),
      [`GET ${LOGS_PATH}`]: () =>
        Response.json([rawMutationLog({ time_spent: 5 })]),
    });
    try {
      const text = await output(
        kitenTimeStopCommand,
        [SELECTOR, "--time", "5"],
        io,
      );
      const body = JSON.parse(seen[2].body);
      assertEquals(
        Date.parse(body.finished_at) - Date.parse(body.started_at),
        5 * 60_000,
      );
      // Начало — старт таймера, усечённый до целой минуты.
      assertEquals(Date.parse(body.started_at) % 60_000, 0);
      assertEquals(notes, []);
      assertEquals(text.includes("записано 5 мин (по факту 20 мин)"), true);
    } finally {
      await stop();
    }
  });

  await t.step("--time ровно по факту: начало не сдвигается", async () => {
    // Граница ветви — минуты, а не моменты: при равенстве финиш ещё может
    // оказаться на секунды впереди «сейчас», и это не повод двигать начало
    // и печатать «больше фактических столько же».
    const startedAtMs = startedHalfMinuteAgo();
    const { io, seen, notes, stop } = stand({
      [`GET ${CARD_PATH}`]: () =>
        Response.json(rawCard({
          timer: rawTimer({
            started_at: new Date(startedAtMs).toISOString(),
          }),
        })),
      [`GET ${ROLES_PATH}`]: () => Response.json(ROLES),
      [`PATCH ${TIMER_PATH}`]: () =>
        Response.json(rawTimer({ card_time_log_id: LOG_ID })),
      [`GET ${LOGS_PATH}`]: () =>
        Response.json([rawMutationLog({ time_spent: 1 })]),
    });
    try {
      const text = await output(
        kitenTimeStopCommand,
        [SELECTOR, "--time", "1"],
        io,
      );
      assertEquals(notes, []);
      // Начало — старт таймера, усечённый до минуты, а не «сейчас минус N».
      const body = JSON.parse(seen[2].body);
      assertEquals(
        Date.parse(body.started_at),
        Math.floor(startedAtMs / 60_000) * 60_000,
      );
      assertEquals(text.includes("(по факту"), false);
    } finally {
      await stop();
    }
  });

  await t.step("--time больше факта: начало сдвинуто назад", async () => {
    const startedAtMs = startedHalfMinuteAgo();
    const started = new Date(startedAtMs).toISOString();
    const beforeMs = Date.now();
    const { io, seen, notes, stop } = stand({
      [`GET ${CARD_PATH}`]: () =>
        Response.json(rawCard({ timer: rawTimer({ started_at: started }) })),
      [`GET ${ROLES_PATH}`]: () => Response.json(ROLES),
      [`PATCH ${TIMER_PATH}`]: () =>
        Response.json(rawTimer({ card_time_log_id: LOG_ID })),
      [`GET ${LOGS_PATH}`]: () =>
        Response.json([rawMutationLog({ time_spent: 120 })]),
    });
    try {
      await output(kitenTimeStopCommand, [SELECTOR, "--time", "2h"], io);
      assertEquals(notes, [
        "внимание: --time 2 ч больше фактических 1 мин — начало сдвинуто назад",
      ]);
      const body = JSON.parse(seen[2].body);
      // Финиш вернулся к «сейчас», назад сдвинулось начало.
      assertEquals(Date.parse(body.finished_at) <= Date.now(), true);
      assertEquals(Date.parse(body.finished_at) >= beforeMs - 60_000, true);
      assertEquals(
        Date.parse(body.finished_at) - Date.parse(body.started_at),
        120 * 60_000,
      );
    } finally {
      await stop();
    }
  });

  await t.step("день записи разошёлся с московским", async () => {
    const { io, notes, stop } = stand({
      [`GET ${CARD_PATH}`]: () => Response.json(rawCard({ timer: rawTimer() })),
      [`GET ${ROLES_PATH}`]: () => Response.json(ROLES),
      [`PATCH ${TIMER_PATH}`]: () =>
        Response.json(rawTimer({ card_time_log_id: LOG_ID })),
      // Сервер берёт день записи от финиша в UTC — в 00:00–03:00 МСК это вчера.
      [`GET ${LOGS_PATH}`]: () =>
        Response.json([rawMutationLog({ for_date: "2020-01-01" })]),
    });
    try {
      await output(kitenTimeStopCommand, [SELECTOR], io);
      assertEquals(notes.length, 1);
      // Команда в подсказке готова к копированию: с реальными id, не с
      // угловыми скобками.
      assertEquals(
        notes[0].includes(
          `поправь: mpu kiten time edit ${CARD_ID} ${LOG_ID} --date `,
        ),
        true,
      );
      assertEquals(notes[0].includes("<"), false);
    } finally {
      await stop();
    }
  });

  await t.step("записи нет в списке — строка с одним id", async () => {
    const { io, baseUrl, stop } = stand({
      [`GET ${CARD_PATH}`]: () => Response.json(rawCard({ timer: rawTimer() })),
      [`GET ${ROLES_PATH}`]: () => Response.json(ROLES),
      [`PATCH ${TIMER_PATH}`]: () =>
        Response.json(rawTimer({ card_time_log_id: LOG_ID })),
      // Запись создана, но в списке её нет: подменять её вычислениями
      // команды нельзя — печатается только то, что сервер точно назвал.
      [`GET ${LOGS_PATH}`]: () => Response.json([]),
    });
    try {
      assertEquals(
        await output(kitenTimeStopCommand, [SELECTOR], io),
        `ok: таймер остановлен · запись ${LOG_ID} · ${baseUrl}/${CARD_ID}\n`,
      );
    } finally {
      await stop();
    }
  });

  await t.step("роли нет в справочнике — печатается её id", async () => {
    const { io, stop } = stand({
      [`GET ${CARD_PATH}`]: () => Response.json(rawCard({ timer: rawTimer() })),
      [`GET ${ROLES_PATH}`]: () => Response.json(ROLES),
      [`PATCH ${TIMER_PATH}`]: () =>
        Response.json(rawTimer({ card_time_log_id: LOG_ID })),
      [`GET ${LOGS_PATH}`]: () =>
        Response.json([rawMutationLog({ role_id: 99999 })]),
    }, { KITEN_TIME_ROLE: "99999" });
    try {
      const text = await output(kitenTimeStopCommand, [SELECTOR], io);
      assertEquals(text.includes("· 99999 · запись"), true);
    } finally {
      await stop();
    }
  });

  await t.step("сервер не назвал id записи — короткая строка", async () => {
    const { io, baseUrl, seen, stop } = stand({
      [`GET ${CARD_PATH}`]: () => Response.json(rawCard({ timer: rawTimer() })),
      [`GET ${ROLES_PATH}`]: () => Response.json(ROLES),
      [`PATCH ${TIMER_PATH}`]: () => Response.json(rawTimer()),
    });
    try {
      assertEquals(
        await output(kitenTimeStopCommand, [SELECTOR], io),
        `ok: таймер остановлен · ${baseUrl}/${CARD_ID}\n`,
      );
      // Перечитывать нечего — четвёртого вызова нет.
      assertEquals(calls(seen).includes(`GET ${LOGS_PATH}`), false);
    } finally {
      await stop();
    }
  });

  await t.step("таймер не запущен — отказ с готовой командой", async () => {
    const { io, seen, stop } = stand({
      [`GET ${CARD_PATH}`]: () => Response.json(rawCard()),
    });
    try {
      assertEquals(
        await errorText(kitenTimeStopCommand, [SELECTOR], io, DomainError),
        `mpu kiten time stop: таймер на карточке ${CARD_ID} не запущен; ` +
          `попробуй: mpu kiten time start ${CARD_ID}\n`,
      );
      assertEquals(calls(seen), [`GET ${CARD_PATH}`]);
    } finally {
      await stop();
    }
  });

  await t.step("длительность разбирается до сети", async () => {
    const { io, seen, stop } = stand({});
    try {
      assertEquals(
        await errorText(
          kitenTimeStopCommand,
          [SELECTOR, "--time", "0"],
          io,
          UsageError,
        ),
        `mpu kiten time stop: ${await golden(
          "err-edit-duration-zero-message.txt",
        )}`,
      );
      assertEquals(calls(seen), []);
    } finally {
      await stop();
    }
  });
});

Deno.test("time discard: сброс без записи", async (t) => {
  await t.step("голден сброса идущего таймера", async () => {
    const { io, baseUrl, seen, stop } = stand({
      [`GET ${CARD_PATH}`]: () => Response.json(rawCard({ timer: rawTimer() })),
      [`DELETE ${TIMER_PATH}`]: () => new Response(null, { status: 204 }),
    });
    try {
      assertEquals(
        await output(kitenTimeDiscardCommand, [SELECTOR], io),
        await expected("discard-stdout.txt", baseUrl),
      );
      assertEquals(calls(seen), [
        `GET ${CARD_PATH}`,
        `DELETE ${TIMER_PATH}`,
      ]);
    } finally {
      await stop();
    }
  });

  await t.step("отказ сброса — доменная ошибка, не паника", async () => {
    const { io, stop } = stand({
      [`GET ${CARD_PATH}`]: () => Response.json(rawCard({ timer: rawTimer() })),
      [`DELETE ${TIMER_PATH}`]: () => new Response("нельзя", { status: 403 }),
    });
    try {
      const text = await errorText(
        kitenTimeDiscardCommand,
        [SELECTOR],
        io,
        DomainError,
      );
      assertEquals(
        text.startsWith("mpu kiten time discard: kaiten error: "),
        true,
      );
    } finally {
      await stop();
    }
  });

  await t.step("идемпотентность: сбрасывать нечего — успех", async () => {
    const { io, baseUrl, seen, stop } = stand({
      [`GET ${CARD_PATH}`]: () => Response.json(rawCard()),
    });
    try {
      assertEquals(
        await output(kitenTimeDiscardCommand, [SELECTOR], io),
        `ok: таймера нет — нечего сбрасывать · ${baseUrl}/${CARD_ID}\n`,
      );
      // Удалять нечего: второго вызова нет, и это не отказ.
      assertEquals(calls(seen), [`GET ${CARD_PATH}`]);
    } finally {
      await stop();
    }
  });
});
