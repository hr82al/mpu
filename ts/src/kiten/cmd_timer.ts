/**
 * Личный таймер карточки — `mpu kiten time start | status | stop |
 * discard` (`docs/specs/kiten-time.md`). Записи того же семейства
 * (`ls`/`add`/`edit`/`rm`) лежат отдельно, в `./cmd_time.ts`: они
 * карточку не читают вовсе, а таймер держится только на ней — поле
 * `timer` полной карточки и есть единственный источник истины о нём
 * (`platform/kaiten-api-time.md`, «Инварианты»).
 *
 * Четыре листа вместе, потому что делят одно: чтение таймера карточки и
 * его натёкшую длительность. Разложенные по файлам, они дали бы четыре
 * места правки на одно изменение контракта.
 *
 * Локального состояния нет: решения принимаются по свежему чтению
 * карточки и по ответу внешней системы, на диск не пишется ничего.
 */

import { z } from "@zod/zod";
import { type CommandIo, defineCommand, DomainError } from "../command/mod.ts";
import {
  getCard,
  type KaitenAccess,
  type KaitenRole,
  listCardTimeLogs,
  listUserRoles,
  parseCardRef,
  resetUserTimer,
  startUserTimer,
  stopUserTimer,
  type Timer,
} from "../kaiten/mod.ts";
import { type AccessIo, asCommandError, kaitenAccess } from "./access.ts";
import { MSK_OFFSET_MINUTES, mskClock, mskDay } from "./msk.ts";
import { parseDuration } from "./time_input.ts";
import { chooseRoleId, ROLE_ENV_KEY, roleNameOf } from "./time_role.ts";
import {
  elapsedMinutes,
  floorToMinute,
  isoAt,
  shiftMinutes,
  zoneOffsetMinutes,
} from "./timer_stamp.ts";
import {
  formatDuration,
  roleLabel,
  type TimeLogView,
  timeLogView,
  timeLogViewSchema,
} from "./time_view.ts";

const selector = z.string({ error: "нужен SELECTOR: id карточки или её URL" })
  .describe("id карточки либо её URL, короткий или глубокий");

const comment = z.string().optional().describe(
  "комментарий; без флага у stop берётся комментарий самого таймера",
);

const cardUrlField = z.string().describe(
  "адрес карточки: базовый URL и её id",
);

const startArgsSchema = z.object({ selector, comment });

const startResultSchema = z.object({
  startedAt: z.string().nullable().describe(
    "метка старта из ответа сервера; сервер её не назвал — null",
  ),
  cardUrl: cardUrlField,
});

const statusArgsSchema = z.object({
  selector,
  json: z.boolean().default(false).describe("вывод объектом, а не строками"),
});

const timerViewSchema = z.object({
  id: z.number().int().describe("id таймера"),
  started_at: z.string().nullable().describe(
    "метка старта, как её отдал сервер",
  ),
  elapsed_minutes: z.number().int().describe(
    "сколько таймер идёт, в целых минутах вверх",
  ),
  comment: z.string().describe("комментарий таймера; пустая строка — его нет"),
});

const statusResultSchema = z.object({
  cardId: z.number().int().describe("id карточки, чей таймер прочитан"),
  timer: timerViewSchema.nullable().describe(
    "идущий таймер; не запущен — null",
  ),
  totalMinutes: z.number().int().describe(
    "сумма минут записей карточки; идущий таймер в неё не входит",
  ),
});

const stopArgsSchema = z.object({
  selector,
  time: z.string().optional().describe(
    "длительность записи вместо натёкшей: 3h | 1h15m | 1:15 | 90 | 2.5h",
  ),
  role: z.string().optional().describe(
    "роль: id либо название; нечисловое значение резолвится справочником",
  ),
  comment,
});

const stopResultSchema = z.object({
  log: timeLogViewSchema.nullable().describe(
    "созданная запись, перечитанная из списка записей карточки; перечитать не удалось — null",
  ),
  logId: z.number().int().nullable().describe(
    "id созданной записи из ответа остановки; сервер его не назвал — null",
  ),
  factMinutes: z.number().int().describe("сколько таймер шёл на самом деле"),
  timeMinutes: z.number().int().nullable().describe(
    "длительность, названная --time; без флага — null",
  ),
  cardUrl: cardUrlField,
});

const discardArgsSchema = z.object({ selector });

const discardResultSchema = z.object({
  elapsedMinutes: z.number().int().nullable().describe(
    "сколько шёл сброшенный таймер; таймера не было — null",
  ),
  cardUrl: cardUrlField,
});

/** Разобранные аргументы `time start`. */
type KitenTimeStartArgs = z.infer<typeof startArgsSchema>;

/** Результат `time start`: момент старта из ответа сервера. */
type KitenTimeStartResult = z.infer<typeof startResultSchema>;

/** Разобранные аргументы `time status`. */
type KitenTimeStatusArgs = z.infer<typeof statusArgsSchema>;

/** Результат `time status`: таймер карточки и её итог по записям. */
type KitenTimeStatusResult = z.infer<typeof statusResultSchema>;

/** Разобранные аргументы `time stop`. */
type KitenTimeStopArgs = z.infer<typeof stopArgsSchema>;

/** Результат `time stop`: созданная запись и её отношение к факту. */
type KitenTimeStopResult = z.infer<typeof stopResultSchema>;

/** Разобранные аргументы `time discard`. */
type KitenTimeDiscardArgs = z.infer<typeof discardArgsSchema>;

/** Результат `time discard`: сколько шёл сброшенный таймер. */
type KitenTimeDiscardResult = z.infer<typeof discardResultSchema>;

/** Срез порта подкоманды, которая предупреждает: доступ плюс канал хода. */
type TimerIo = AccessIo & Pick<CommandIo, "progress">;

/**
 * Границы записи, которую создаст остановка: что уходит серверу и что из
 * этого надо сказать человеку.
 */
interface StopSpan {
  /** Начало; не задано — сервер берёт фактический старт таймера. */
  readonly startedAt?: string;
  readonly finishedAt: string;
  /** Тот же финиш моментом: по нему считается московский день записи. */
  readonly finishedAtMs: number;
  readonly factMinutes: number;
  /** Предупреждение о сдвинутом назад начале; сдвига не было — `null`. */
  readonly warning: string | null;
}

/**
 * Запускает таймер. Запрос на старт ровно один: конфликт узнаётся из
 * ответа внешней системы, а не предугадывается локально — локального
 * состояния у команды нет, а ответ 400 одинаков для своей и чужой
 * карточки (`kiten-time.md`, «Известные отклонения»).
 */
async function runKitenTimeStart(
  args: KitenTimeStartArgs,
  io: AccessIo,
): Promise<KitenTimeStartResult> {
  const cardId = parseCardRef(args.selector);
  const access = kaitenAccess(io);
  try {
    // Свежее чтение карточки перед стартом — инвариант спеки: несуществующая
    // карточка отсеивается до мутации, а не отказом на ней.
    await getCard(access, cardId);
    const outcome = await startUserTimer(access, {
      cardId,
      comment: args.comment,
    });
    if (outcome.kind === "conflict") throw await conflictError(access, cardId);
    return {
      startedAt: outcome.timer.startedAt,
      cardUrl: cardUrl(access, cardId),
    };
  } catch (err) {
    throw asCommandError(err);
  }
}

/** Читает таймер карточки и её итог по записям; мутаций не делает. */
async function runKitenTimeStatus(
  args: KitenTimeStatusArgs,
  io: AccessIo,
): Promise<KitenTimeStatusResult> {
  const cardId = parseCardRef(args.selector);
  const access = kaitenAccess(io);
  try {
    const card = await getCard(access, cardId);
    return {
      cardId,
      timer: card.timer === null ? null : timerView(card.timer, Date.now()),
      // «Всего по карточке» считает записи, а не идущий таймер: сумма
      // приходит с карточки и натёкшего времени не включает.
      totalMinutes: card.timeSpentSum ?? 0,
    };
  } catch (err) {
    throw asCommandError(err);
  }
}

/**
 * Останавливает таймер, создавая запись. Четыре вызова: карточка (за
 * таймером), справочник ролей (роль записи и её название для вывода),
 * остановка и перечитывание созданной записи — печатается она, а не
 * собственные вычисления команды (инвариант спеки).
 */
async function runKitenTimeStop(
  args: KitenTimeStopArgs,
  io: TimerIo,
): Promise<KitenTimeStopResult> {
  const cardId = parseCardRef(args.selector);
  const timeMinutes = args.time === undefined
    ? null
    : parseDuration(args.time, "--time");
  const access = kaitenAccess(io);
  try {
    const timer = await requireTimer(access, cardId);
    const roles = await listUserRoles(access);
    const roleId = chooseRoleId(roles, args.role, io.envFile.get(ROLE_ENV_KEY));
    const span = stopSpan(timer.startedAt, timeMinutes, Date.now());
    if (span.warning !== null) io.progress(span.warning);
    const stopped = await stopUserTimer(access, timer.id, {
      startedAt: span.startedAt,
      finishedAt: span.finishedAt,
      // Комментарий таймера сам сервер в запись не переносит, поэтому
      // уходит в запрос всегда — свой либо прочитанный с таймера.
      comment: args.comment ?? timer.comment,
      roleId,
    });
    const logId = stopped.cardTimeLogId;
    const log = logId === null
      ? null
      : await rereadLog(access, cardId, logId, roles);
    if (log !== null) warnShiftedDay(io, cardId, log, span.finishedAtMs);
    return {
      log,
      logId,
      factMinutes: span.factMinutes,
      timeMinutes,
      cardUrl: cardUrl(access, cardId),
    };
  } catch (err) {
    throw asCommandError(err);
  }
}

/**
 * Сбрасывает таймер без создания записи. Идемпотентно: сбрасывать
 * нечего — успех, а не отказ. У `stop` наоборот: там тихий успех означал
 * бы потерянную работу.
 */
async function runKitenTimeDiscard(
  args: KitenTimeDiscardArgs,
  io: AccessIo,
): Promise<KitenTimeDiscardResult> {
  const cardId = parseCardRef(args.selector);
  const access = kaitenAccess(io);
  try {
    const timer = (await getCard(access, cardId)).timer;
    if (timer === null) {
      return { elapsedMinutes: null, cardUrl: cardUrl(access, cardId) };
    }
    const elapsed = timerElapsed(timer, Date.now());
    await resetUserTimer(access, timer.id);
    return { elapsedMinutes: elapsed, cardUrl: cardUrl(access, cardId) };
  } catch (err) {
    throw asCommandError(err);
  }
}

/** Идущий таймер карточки; его нет — доменный отказ с готовой командой. */
async function requireTimer(
  access: KaitenAccess,
  cardId: number,
): Promise<Timer> {
  const timer = (await getCard(access, cardId)).timer;
  if (timer === null) {
    throw new DomainError(`таймер на карточке ${cardId} не запущен`, {
      hint: `mpu kiten time start ${cardId}`,
    });
  }
  return timer;
}

/**
 * Отказ конфликта запуска. Ответ 400 карточку не называет, поэтому
 * карточка селектора перечитывается уже после конфликта, и ветвей от
 * этого чтения две: таймер на ней есть — он и есть виновник, названный
 * по имени; таймера нет — значит он идёт на другой карточке, и назвать
 * её нечем (поле `timer` отдаёт только своя карточка, глобального
 * списка таймеров у внешней системы нет). Во второй ветви подсказки нет
 * вовсе: подставить в неё карточку селектора — соврать. Само чтение
 * может и отказать — тогда наружу уходит его ошибка: своего текста у
 * этого исхода нет, а выдумывать карточку нечем.
 */
async function conflictError(
  access: KaitenAccess,
  cardId: number,
): Promise<DomainError> {
  const timer = (await getCard(access, cardId)).timer;
  if (timer === null) {
    return new DomainError(
      "таймер уже идёт на другой карточке; " +
        "Kaiten не сообщает, на какой — найди её в интерфейсе",
    );
  }
  const clock = startedClock(timer.startedAt);
  const since = clock === null ? "" : ` (с ${clock})`;
  return new DomainError(`таймер уже идёт на карточке ${cardId}${since}`, {
    advice: `останови \`mpu kiten time stop ${cardId}\` или сбрось ` +
      `\`mpu kiten time discard ${cardId}\``,
  });
}

/**
 * Созданная запись из списка записей карточки; её там нет — `null`.
 * Название роли ответ остановки не несёт, как и ответы создания и правки
 * записи, поэтому берётся из уже прочитанного справочника.
 */
async function rereadLog(
  access: KaitenAccess,
  cardId: number,
  logId: number,
  roles: readonly KaitenRole[],
): Promise<TimeLogView | null> {
  const logs = await listCardTimeLogs(access, cardId);
  const log = logs.find((item) => item.id === logId);
  if (log === undefined) return null;
  return { ...timeLogView(log), role: roleNameOf(roles, log.roleId) };
}

/**
 * Границы записи по натёкшему времени либо по `--time`. Без `--time`
 * начало не передаётся вовсе — его знает сервер. С `--time` начало
 * усекается до целой минуты, а финиш, который попал бы в будущее,
 * возвращается к «сейчас», и назад сдвигается уже начало.
 */
function stopSpan(
  startedAt: string | null,
  minutes: number | null,
  nowMs: number,
): StopSpan {
  const zone = zoneOf(startedAt);
  const beganMs = momentOf(startedAt) ?? nowMs;
  const factMinutes = elapsedMinutes(beganMs, nowMs);
  if (minutes === null) {
    return {
      finishedAt: isoAt(nowMs, zone),
      finishedAtMs: nowMs,
      factMinutes,
      warning: null,
    };
  }
  // Ветвление по минутам, а не по миллисекундам: спека определяет
  // границу как «N больше натёкшего», и сравнение моментов сделало бы
  // поведение зависимым от положения секунд внутри минуты.
  if (minutes <= factMinutes) {
    const from = floorToMinute(beganMs);
    const to = shiftMinutes(from, minutes);
    return {
      startedAt: isoAt(from, zone),
      finishedAt: isoAt(to, zone),
      finishedAtMs: to,
      factMinutes,
      warning: null,
    };
  }
  const finish = floorToMinute(nowMs);
  return {
    startedAt: isoAt(shiftMinutes(finish, -minutes), zone),
    finishedAt: isoAt(finish, zone),
    finishedAtMs: finish,
    factMinutes,
    warning: `внимание: --time ${formatDuration(minutes)} больше фактических ${
      formatDuration(factMinutes)
    } — начало сдвинуто назад`,
  };
}

/**
 * Предупреждение о дне записи, разошедшемся с московским днём финиша:
 * день записи сервер берёт от финиша в UTC, и в 00:00–03:00 МСК это
 * вчера. Команда в подсказке готова к копированию — с реальными id.
 */
function warnShiftedDay(
  io: TimerIo,
  cardId: number,
  log: TimeLogView,
  finishedAtMs: number,
): void {
  const day = mskDay(finishedAtMs);
  if (log.for_date === day) return;
  io.progress(
    `внимание: сервер записал день ${log.for_date}, по МСК это ${day}; ` +
      `поправь: mpu kiten time edit ${cardId} ${log.id} --date ${day}`,
  );
}

/** Таймер глазами вывода: натёкшее считается на момент чтения. */
function timerView(
  timer: Timer,
  nowMs: number,
): z.infer<typeof timerViewSchema> {
  return {
    id: timer.id,
    started_at: timer.startedAt,
    elapsed_minutes: timerElapsed(timer, nowMs),
    comment: timer.comment,
  };
}

/** Натёкшая длительность таймера; метки старта нет — 0. */
function timerElapsed(timer: Timer, nowMs: number): number {
  const beganMs = momentOf(timer.startedAt);
  return beganMs === null ? 0 : elapsedMinutes(beganMs, nowMs);
}

/** Часы старта для строки вывода; метки нет или она неразборна — `null`. */
function startedClock(startedAt: string | null): string | null {
  const atMs = momentOf(startedAt);
  return atMs === null ? null : `${mskClock(atMs)} МСК`;
}

/** Момент ISO-метки; метки нет или она неразборна — `null`. */
function momentOf(iso: string | null): number | null {
  if (iso === null) return null;
  const atMs = Date.parse(iso);
  return Number.isNaN(atMs) ? null : atMs;
}

/** Зона метки старта; её в метке нет — московская, зона записей компании. */
function zoneOf(startedAt: string | null): number {
  const zone = startedAt === null ? null : zoneOffsetMinutes(startedAt);
  return zone ?? MSK_OFFSET_MINUTES;
}

/** Адрес карточки для человека: базовый URL API и id, не ответ сервера. */
function cardUrl(access: KaitenAccess, cardId: number): string {
  return `${access.baseUrl}/${cardId}`;
}

/** Строки `status` для человека: состояние таймера и итог по карточке. */
function renderStatus(result: KitenTimeStatusResult): string {
  const { timer } = result;
  const total = `всего по карточке: ${formatDuration(result.totalMinutes)}\n`;
  if (timer === null) return `таймер: не запущен\n${total}`;
  const clock = startedClock(timer.started_at);
  const since = clock === null ? "" : ` (с ${clock})`;
  const note = timer.comment === "" ? "" : ` · «${timer.comment}»`;
  return `таймер: идёт ${
    formatDuration(timer.elapsed_minutes)
  }${since}${note}\n${total}`;
}

/** JSON-вывод `status`: отступ 2, ровно один перевод строки в конце. */
function renderStatusJson(result: KitenTimeStatusResult): string {
  const body = {
    card_id: result.cardId,
    timer: result.timer,
    total_minutes: result.totalMinutes,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * Строка успеха `stop`. Печатается перечитанная запись; её не оказалось
 * — остаётся то, что сервер точно назвал, и подмены вычислениями команды
 * не происходит ни в одном случае.
 */
function renderStop(result: KitenTimeStopResult): string {
  const head = "ok: таймер остановлен";
  const { log } = result;
  if (log === null) {
    const id = result.logId === null ? "" : ` · запись ${result.logId}`;
    return `${head}${id} · ${result.cardUrl}\n`;
  }
  // «По факту» показывается, когда --time разошёлся с НАТЁКШИМ временем,
  // а не с тем, что записал сервер: расходится именно с фактом.
  const fact = result.timeMinutes !== null &&
      result.timeMinutes !== result.factMinutes
    ? ` (по факту ${formatDuration(result.factMinutes)})`
    : "";
  return `${head} · записано ${
    formatDuration(log.minutes)
  }${fact} · ${log.for_date} · ${
    roleLabel(log)
  } · запись ${log.id} · ${result.cardUrl}\n`;
}

const ENV_KEYS = `Ключи env-файла: KITEN_API_KEY (обязателен), KITEN_BASE_URL
(по умолчанию https://btlz.kaiten.ru).`;

export const kitenTimeStartCommand = defineCommand({
  path: ["kiten", "time", "start"],
  errorName: "kiten time start",
  summary: "Запустить личный таймер на карточке Kaiten.",
  usage: "mpu kiten time start SELECTOR [--comment TEXT]",
  help: `SELECTOR — id карточки либо её URL.

Роль таймер не хранит — внешний API её у него не держит, и флага --role
у start нет: роль выбирается при остановке, цепочкой --role → env →
умолчание.

--comment/-m — комментарий; он хранится на таймере и уходит в запись при
stop, если у stop своего комментария нет.

Таймер у пользователя один на всю компанию. Если он уже идёт — неважно,
на этой карточке или на другой, — start отвечает ошибкой. Идущий на этой
же карточке называется по имени, с временем начала; идущий на другой
Kaiten не называет никак — его придётся найти в интерфейсе. Флага
--force нет: обходить нечего.

${ENV_KEYS}

Exit: 0 — успех; 1 — таймер уже идёт, ошибка API Kaiten; 2 — ошибка
ввода (селектор, ненастроенный KITEN_API_KEY).

Пример: mpu kiten time start 10000001 -m 'разбор жалобы'`,
  policy: "rw",
  argsSchema: startArgsSchema,
  forms: { selector: { positional: "one" }, comment: { short: "m" } },
  resultSchema: startResultSchema,
  run: runKitenTimeStart,
  render: ({ startedAt, cardUrl }) => {
    const clock = startedClock(startedAt);
    const at = clock === null ? "" : ` ${clock}`;
    return `ok: таймер запущен${at} · ${cardUrl}\n`;
  },
});

export const kitenTimeStatusCommand = defineCommand({
  path: ["kiten", "time", "status"],
  errorName: "kiten time status",
  summary: "Показать состояние личного таймера карточки Kaiten.",
  usage: "mpu kiten time status SELECTOR [--json]",
  help: `SELECTOR — id карточки либо её URL.

Чтение без мутаций: одно обращение к карточке. Печатает две строки —
состояние таймера («идёт <длительность> (с <ЧЧ:ММ МСК>)» и комментарий,
если он есть, либо «не запущен») и «всего по карточке». Итог считает
записи учёта времени, идущий таймер в него не входит.

--json печатает {"card_id", "timer", "total_minutes"}, где timer — либо
null, либо {id, started_at, elapsed_minutes, comment}.

${ENV_KEYS}

Exit: 0 — успех; 1 — ошибка API Kaiten; 2 — ошибка ввода (селектор,
ненастроенный KITEN_API_KEY).

Пример: mpu kiten time status 10000001`,
  policy: "ro",
  argsSchema: statusArgsSchema,
  forms: { selector: { positional: "one" } },
  resultSchema: statusResultSchema,
  run: runKitenTimeStatus,
  render: (result, args) =>
    args.json ? renderStatusJson(result) : renderStatus(result),
});

export const kitenTimeStopCommand = defineCommand({
  path: ["kiten", "time", "stop"],
  errorName: "kiten time stop",
  summary: "Остановить таймер карточки Kaiten, создав запись времени.",
  usage:
    "mpu kiten time stop SELECTOR [--time DURATION] [--role REF] [--comment TEXT]",
  help: `SELECTOR — id карточки либо её URL.

Без --time записывается натёкшее время. С --time N начало берётся от
старта таймера, усечённого до минуты, а финиш — начало + N; если такой
финиш попал бы в будущее, финиш становится «сейчас», а назад сдвигается
начало, и об этом предупреждает stderr.

Длительность: 3h | 1h15m | 1:15 | 90 (голое число — минуты) | 2.5h;
единицы h/m/ч/м, дробь округляется вверх до минуты, итог 1..1440 минут.

Роль: --role (id либо название) → ключ ${ROLE_ENV_KEY} env-файла → 12058
(«Техподдержка»). Комментарий: свой -m, иначе комментарий таймера.

Печатается запись, ПЕРЕЧИТАННАЯ с сервера, а не вычисленная командой.
День записи сервер берёт от финиша в UTC, поэтому в 00:00–03:00 МСК он
может разойтись с московским — тогда stderr печатает готовую команду
правки.

${ENV_KEYS}

Exit: 0 — успех; 1 — таймер не запущен, ошибка API Kaiten; 2 — ошибка
ввода (длительность, роль, селектор, ненастроенный KITEN_API_KEY).

Пример: mpu kiten time stop 10000001 --role Диагностика -m 'разбор'`,
  policy: "rw",
  argsSchema: stopArgsSchema,
  forms: { selector: { positional: "one" }, comment: { short: "m" } },
  resultSchema: stopResultSchema,
  run: runKitenTimeStop,
  render: renderStop,
});

export const kitenTimeDiscardCommand = defineCommand({
  path: ["kiten", "time", "discard"],
  errorName: "kiten time discard",
  summary: "Сбросить таймер карточки Kaiten без создания записи.",
  usage: "mpu kiten time discard SELECTOR",
  help: `SELECTOR — id карточки либо её URL.

Сбрасывает идущий таймер, не создавая записи учёта времени: натёкшее
время пропадает. Нужна запись — останавливай через stop.

Идемпотентно: таймера нет — «ok: таймера нет — нечего сбрасывать» и exit
0. У stop наоборот, там тихий успех означал бы потерянную работу.

${ENV_KEYS}

Exit: 0 — успех и «нечего сбрасывать»; 1 — ошибка API Kaiten; 2 — ошибка
ввода (селектор, ненастроенный KITEN_API_KEY).

Пример: mpu kiten time discard 10000001`,
  policy: "rw",
  argsSchema: discardArgsSchema,
  forms: { selector: { positional: "one" } },
  resultSchema: discardResultSchema,
  run: runKitenTimeDiscard,
  render: ({ elapsedMinutes, cardUrl }) =>
    elapsedMinutes === null
      ? `ok: таймера нет — нечего сбрасывать · ${cardUrl}\n`
      : `ok: таймер сброшен без записи (шёл ${
        formatDuration(elapsedMinutes)
      }) · ${cardUrl}\n`,
});
