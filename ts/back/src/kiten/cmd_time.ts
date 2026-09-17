/**
 * Записи учёта времени карточки — `mpu kiten time ls | add | edit | rm`
 * (`docs/specs/kiten-time.md`). Личный таймер того же семейства
 * (`start`/`status`/`stop`/`discard`) лежит отдельно: записи карточку не
 * читают вовсе, а таймер держится только на ней.
 *
 * Четыре листа вместе, потому что делят три вещи — поиск записи на
 * карточке с проверкой владельца, форму вывода записи и разбор входа.
 * Разложенные по файлам, они дали бы четыре места правки на одно
 * изменение контракта. Про HTTP и форму ответов сервера здесь не знают —
 * только про каталог (`../kaiten/mod.ts`).
 *
 * Локального состояния у команды нет: на диск не пишется ничего
 * (`kiten-time.md`, «Побочные эффекты»).
 */

import { z } from "@zod/zod";
import {
  type CommandIo,
  defineCommand,
  DomainError,
  UsageError,
} from "../command/mod.ts";
import {
  createCardTimeLog,
  deleteCardTimeLog,
  getCurrentUser,
  type KaitenAccess,
  type KaitenRole,
  listCardTimeLogs,
  listUserRoles,
  parseCardRef,
  type TimeLog,
  type TimeLogPatch,
  updateCardTimeLog,
} from "../kaiten/mod.ts";
import {
  type AccessIo,
  asCommandError,
  cardUrl,
  kaitenAccess,
} from "./access.ts";
import { mskDay } from "./msk.ts";
import { parseCalendarDate, parseDuration } from "./time_input.ts";
import {
  chooseRoleId,
  pickRoleId,
  resolveRoleId,
  ROLE_ENV_KEY,
  roleNameOf,
} from "./time_role.ts";
import {
  formatDuration,
  renderTimeLogJson,
  renderTimeLogTable,
  roleLabel,
  type TimeLogView,
  timeLogView,
  timeLogViewSchema,
} from "./time_view.ts";

/** Оси частичного обновления в порядке печати — он же порядок справки. */
const EDIT_AXES = ["time", "date", "role", "comment"] as const;

/** Ось, названная в вызове `edit`. */
type EditAxis = typeof EDIT_AXES[number];

/** Только цифры: id записи приходит строкой и из argv, и из объекта тула. */
const NUMERIC_ID = /^\d+$/;

const selector = z.string({ error: "нужен SELECTOR: id карточки или её URL" })
  .describe("id карточки либо её URL, короткий или глубокий");

const logId = z.string({ error: "нужен LOG_ID: id записи" })
  .describe("id записи учёта времени с этой карточки");

const roleRef = z.string().optional().describe(
  "роль: id либо название; нечисловое значение резолвится справочником",
);

const force = z.boolean().default(false).describe(
  "разрешить действие над записью другого пользователя",
);

const lsArgsSchema = z.object({
  selector,
  all: z.boolean().default(false).describe(
    "записи всех пользователей, а не только владельца токена",
  ),
  "date-from": z.string().optional().describe(
    "нижняя граница даты записи YYYY-MM-DD, включительно",
  ),
  "date-to": z.string().optional().describe(
    "верхняя граница даты записи YYYY-MM-DD, включительно",
  ),
  role: roleRef,
  json: z.boolean().default(false).describe("вывод объектом, а не таблицей"),
});

const lsResultSchema = z.object({
  cardId: z.number().int().describe("id карточки, чьи записи прочитаны"),
  totalMinutes: z.number().int().describe("сумма минут показанных записей"),
  logs: z.array(timeLogViewSchema).describe(
    "записи после фильтров, в порядке ответа внешней системы",
  ),
});

const addArgsSchema = z.object({
  selector,
  duration: z.string({ error: "нужен DURATION: длительность записи" })
    .describe("длительность: 3h | 1h15m | 1:15 | 90 (минуты) | 2.5h"),
  date: z.string().optional().describe(
    "день записи YYYY-MM-DD; без флага — сегодня по МСК",
  ),
  role: roleRef,
  comment: z.string().default("").describe(
    "комментарий записи; пустой — записи без комментария",
  ),
});

const addResultSchema = z.object({
  log: timeLogViewSchema.describe("созданная запись, как её вернул сервер"),
  cardUrl: z.string().describe("адрес карточки: базовый URL и её id"),
});

const editArgsSchema = z.object({
  selector,
  logId,
  time: z.string().optional().describe("новая длительность записи"),
  date: z.string().optional().describe("новый день записи YYYY-MM-DD"),
  role: roleRef,
  comment: z.string().optional().describe(
    "новый комментарий; пустая строка очищает прежний",
  ),
  force,
});

const editResultSchema = z.object({
  log: timeLogViewSchema.describe("запись после обновления"),
  changed: z.array(z.enum(EDIT_AXES)).describe(
    "оси, заданные вызовом: только они уходили в тело обновления",
  ),
  cardUrl: z.string().describe("адрес карточки: базовый URL и её id"),
});

const rmArgsSchema = z.object({ selector, logId, force });

const rmResultSchema = z.object({
  log: timeLogViewSchema.describe("удалённая запись, прочитанная до удаления"),
  cardUrl: z.string().describe("адрес карточки: базовый URL и её id"),
});

/** Разобранные аргументы `time ls`. */
type KitenTimeLsArgs = z.infer<typeof lsArgsSchema>;

/** Результат `time ls`: отобранные записи и их сумма. */
type KitenTimeLsResult = z.infer<typeof lsResultSchema>;

/** Разобранные аргументы `time add`. */
type KitenTimeAddArgs = z.infer<typeof addArgsSchema>;

/** Результат `time add`: созданная запись и адрес карточки. */
type KitenTimeAddResult = z.infer<typeof addResultSchema>;

/** Разобранные аргументы `time edit`. */
type KitenTimeEditArgs = z.infer<typeof editArgsSchema>;

/** Результат `time edit`: запись после обновления и заданные оси. */
type KitenTimeEditResult = z.infer<typeof editResultSchema>;

/** Разобранные аргументы `time rm`. */
type KitenTimeRmArgs = z.infer<typeof rmArgsSchema>;

/** Результат `time rm`: удалённая запись целиком. */
type KitenTimeRmResult = z.infer<typeof rmResultSchema>;

/** Срез порта `add`: доступ к Kaiten плюс канал предупреждений. */
type AddIo = AccessIo & Pick<CommandIo, "progress">;

/**
 * Записи карточки после клиентских фильтров. Фильтр «только мои» —
 * всегда клиентский: внешняя система отдаёт записи всей компании
 * (`kiten-time.md`, «Инварианты»), поэтому без `--all` идёт второй вызов
 * — за владельцем токена, а с `--all` его нет.
 */
async function runKitenTimeLs(
  args: KitenTimeLsArgs,
  io: AccessIo,
): Promise<KitenTimeLsResult> {
  const cardId = parseCardRef(args.selector);
  const from = optionalDate(args["date-from"], "--date-from");
  const to = optionalDate(args["date-to"], "--date-to");
  const access = kaitenAccess(io);
  try {
    // Роль здесь — ФИЛЬТР, а не выбор роли записи: цепочки «env →
    // дефолт» у него нет, иначе `ls` без флага молча показывал бы одну
    // роль из нескольких.
    const roleId = args.role === undefined
      ? null
      : await resolveRoleId(access, args.role);
    const logs = await listCardTimeLogs(access, cardId);
    const owner = args.all ? null : (await getCurrentUser(access)).id;
    const kept = logs.filter((log) =>
      (owner === null || log.userId === owner) &&
      (roleId === null || log.roleId === roleId) &&
      (from === undefined || log.forDate >= from) &&
      (to === undefined || log.forDate <= to)
    );
    return {
      cardId,
      totalMinutes: kept.reduce((sum, log) => sum + log.timeSpent, 0),
      logs: kept.map(timeLogView),
    };
  } catch (err) {
    throw asCommandError(err);
  }
}

/**
 * Создаёт запись. Дата в будущем не блокируется — о ней предупреждают, и
 * предупреждение уходит до запроса: отказ сервера не должен его съесть.
 */
async function runKitenTimeAdd(
  args: KitenTimeAddArgs,
  io: AddIo,
): Promise<KitenTimeAddResult> {
  const cardId = parseCardRef(args.selector);
  const timeSpent = parseDuration(args.duration, "DURATION");
  const today = mskDay();
  const forDate = args.date === undefined
    ? today
    : parseCalendarDate(args.date, "--date");
  const access = kaitenAccess(io);
  if (forDate > today) io.progress(`внимание: дата ${forDate} в будущем`);
  try {
    // Справочник читается всегда, а не только ради резолва нечислового
    // значения: ответ создания записи названия роли не несёт вовсе
    // (`platform/kaiten-api-time.md`, «Инварианты»), а строка успеха
    // печатает название.
    const roles = await listUserRoles(access);
    const roleId = chooseRoleId(roles, args.role, io.envFile.get(ROLE_ENV_KEY));
    const log = await createCardTimeLog(access, cardId, {
      forDate,
      timeSpent,
      roleId,
      comment: args.comment,
    });
    return {
      log: withRoleName(log, roles),
      cardUrl: cardUrl(access, cardId),
    };
  } catch (err) {
    throw asCommandError(err);
  }
}

/**
 * Частичное обновление: тело собирается только из заданных осей и пустым
 * не отправляется никогда. `--comment ''` — ось (очистка), а не её
 * отсутствие, поэтому оси различаются по `undefined`, а не по пустоте.
 */
async function runKitenTimeEdit(
  args: KitenTimeEditArgs,
  io: AccessIo,
): Promise<KitenTimeEditResult> {
  const cardId = parseCardRef(args.selector);
  const id = parseLogId(args.logId);
  const changed = EDIT_AXES.filter((axis) => args[axis] !== undefined);
  if (changed.length === 0) {
    throw new UsageError(
      "нужно хотя бы одно из --time / --date / --role / --comment",
    );
  }
  const patch: TimeLogPatch = {
    timeSpent: args.time === undefined
      ? undefined
      : parseDuration(args.time, "--time"),
    forDate: optionalDate(args.date, "--date"),
    comment: args.comment,
  };
  const access = kaitenAccess(io);
  try {
    // Справочник нужен только оси роли — и ради резолва названия, и ради
    // печати: ответ правки записи название роли не несёт. Остальные оси
    // берут значения из ответа сервера и запроса не стоят.
    const roles = args.role === undefined ? [] : await listUserRoles(access);
    const roleId = args.role === undefined
      ? undefined
      : pickRoleId(roles, args.role);
    await requireOwnLog(access, cardId, id, args.force);
    const log = await updateCardTimeLog(access, cardId, id, {
      ...patch,
      roleId,
    });
    return {
      log: withRoleName(log, roles),
      changed,
      cardUrl: cardUrl(access, cardId),
    };
  } catch (err) {
    throw asCommandError(err);
  }
}

/**
 * Удаляет запись и печатает её целиком — страховка от опечатки в id:
 * увидеть, что именно исчезло, можно только до удаления.
 */
async function runKitenTimeRm(
  args: KitenTimeRmArgs,
  io: AccessIo,
): Promise<KitenTimeRmResult> {
  const cardId = parseCardRef(args.selector);
  const id = parseLogId(args.logId);
  const access = kaitenAccess(io);
  try {
    const log = await requireOwnLog(access, cardId, id, args.force);
    await deleteCardTimeLog(access, cardId, id);
    return { log: timeLogView(log), cardUrl: cardUrl(access, cardId) };
  } catch (err) {
    throw asCommandError(err);
  }
}

/**
 * Запись с этой карточки, которую вызывающему позволено менять. Владелец
 * проверяется вторым вызовом, и его нет ни при `--force` (проверять
 * нечего), ни у записи без владельца — такие спека разрешает без
 * ограничений.
 */
async function requireOwnLog(
  access: KaitenAccess,
  cardId: number,
  logId: number,
  force: boolean,
): Promise<TimeLog> {
  const logs = await listCardTimeLogs(access, cardId);
  const log = logs.find((item) => item.id === logId);
  if (log === undefined) {
    throw new DomainError(`записи ${logId} нет на карточке ${cardId}`, {
      hint: `mpu kiten time ls ${cardId}`,
    });
  }
  if (force || log.userId === null) return log;
  const owner = (await getCurrentUser(access)).id;
  if (log.userId !== owner) {
    throw new DomainError(
      `запись ${logId} принадлежит другому пользователю ` +
        `(user_id=${log.userId}, я ${owner}); повтори с --force`,
    );
  }
  return log;
}

/**
 * Запись в форме вывода с названием роли из справочника. Ответы создания
 * и правки записи названия не несут вовсе — только `role_id`
 * (`platform/kaiten-api-time.md`, «Инварианты»), поэтому его подставляют
 * здесь; пустой справочник (ось роли не названа) оставляет `null`, и
 * тогда роль в выводе не печатается вовсе.
 */
function withRoleName(
  log: TimeLog,
  roles: readonly KaitenRole[],
): TimeLogView {
  const view = timeLogView(log);
  return { ...view, role: roleNameOf(roles, view.role_id) };
}

/** Дата флага, если он задан; иначе `undefined` — «ось не названа». */
function optionalDate(
  value: string | undefined,
  flag: string,
): string | undefined {
  return value === undefined ? undefined : parseCalendarDate(value, flag);
}

/** id записи из строки argv; нецелое — ошибка ввода до всякой сети. */
function parseLogId(raw: string): number {
  if (!NUMERIC_ID.test(raw)) {
    throw new UsageError(`LOG_ID '${raw}': ожидается id записи — целое число`);
  }
  return Number(raw);
}

/** Оси строкой в порядке `EDIT_AXES`: печатаются только заданные. */
function axisLines(result: KitenTimeEditResult): readonly string[] {
  const { log } = result;
  return result.changed.map((axis) => {
    switch (axis) {
      case "time":
        return `время ${formatDuration(log.minutes)}`;
      case "date":
        return `дата ${log.for_date}`;
      case "role":
        return `роль ${roleLabel(log)}`;
      case "comment":
        return log.comment === ""
          ? "комментарий очищен"
          : `комментарий «${log.comment}»`;
      default: {
        const never: never = axis;
        throw new TypeError(`неизвестная ось обновления: ${never}`);
      }
    }
  });
}

const ROLE_SOURCES = `Роль: --role (id либо название) → ключ ${ROLE_ENV_KEY}
env-файла → 12058 («Техподдержка»). Числовое значение берётся как id,
нечисловое резолвится справочником ролей.`;

const ENV_KEYS = `Ключи env-файла: KITEN_API_KEY (обязателен), KITEN_BASE_URL
(по умолчанию https://btlz.kaiten.ru).`;

const DURATION_HELP = `Длительность: 3h | 1h15m | 1:15 | 90 (голое число —
минуты) | 2.5h; единицы h/m/ч/м, регистр и пробелы внутри не значимы,
дробь округляется вверх до минуты, итог 1..1440 минут.`;

export const kitenTimeLsCommand = defineCommand({
  path: ["kiten", "time", "ls"],
  errorName: "kiten time ls",
  summary: "Показать записи учёта времени карточки Kaiten.",
  usage:
    "mpu kiten time ls SELECTOR [--all] [--date-from D] [--date-to D] [--role REF] [--json]",
  help: `SELECTOR — id карточки либо её URL.

По умолчанию показаны только записи владельца токена: внешняя система
отдаёт записи всей компании, и фильтр делается на стороне команды —
поэтому без --all идёт второй запрос, за текущим пользователем. С --all
записи всех пользователей и появляется колонка ПОЛЬЗОВАТЕЛЬ.

--date-from/--date-to — границы даты записи YYYY-MM-DD, обе включительно.
--role фильтрует по роли; без флага фильтра по роли нет (ни env, ни
умолчание здесь не подставляются).

Таблица: ID ДАТА ВРЕМЯ РОЛЬ [ПОЛЬЗОВАТЕЛЬ] КОММЕНТАРИЙ и строка «итого».
Ширина колонок подгоняется под содержимое и контрактом не является. Нет
записей — «(пусто)». --json печатает {"total_minutes", "logs":[…]}, где у
записи поле role — название роли либо null (в таблице на его месте
числовой id).

${ENV_KEYS}

Exit: 0 — успех; 1 — ошибка API Kaiten; 2 — ошибка ввода (селектор, даты,
роль, ненастроенный KITEN_API_KEY).

Пример: mpu kiten time ls 10000001 --date-from 2026-08-01`,
  policy: "ro",
  argsSchema: lsArgsSchema,
  forms: { selector: { positional: "one" } },
  resultSchema: lsResultSchema,
  run: runKitenTimeLs,
  render: (result, args) =>
    args.json
      ? renderTimeLogJson(result.logs, result.totalMinutes)
      : renderTimeLogTable(result.logs, result.totalMinutes, {
        withUser: args.all,
      }),
});

export const kitenTimeAddCommand = defineCommand({
  path: ["kiten", "time", "add"],
  errorName: "kiten time add",
  summary: "Создать запись учёта времени на карточке Kaiten.",
  usage:
    "mpu kiten time add SELECTOR DURATION [--date D] [--role REF] [--comment TEXT]",
  help: `SELECTOR — id карточки либо её URL. DURATION — позиционный
аргумент, флага --time у add нет.

${DURATION_HELP}

--date — день записи YYYY-MM-DD; без флага сегодня по МСК, а не по зоне
машины. Дата в будущем не блокируется: в stderr уходит «внимание: дата
<D> в будущем», запись создаётся.

--comment/-m — комментарий; без флага запись без комментария.

${ROLE_SOURCES}

${ENV_KEYS}

Exit: 0 — успех; 1 — ошибка API Kaiten; 2 — ошибка ввода (длительность,
дата, роль, селектор, ненастроенный KITEN_API_KEY).

Пример: mpu kiten time add 10000001 1h30m -m 'фикс'`,
  policy: "rw",
  argsSchema: addArgsSchema,
  forms: {
    selector: { positional: "one" },
    duration: { positional: "one" },
    comment: { short: "m" },
  },
  resultSchema: addResultSchema,
  run: runKitenTimeAdd,
  render: ({ log, cardUrl }) =>
    `ok: +${formatDuration(log.minutes)} · ${log.for_date} · ${
      roleLabel(log)
    } · запись ${log.id} · ${cardUrl}\n`,
});

export const kitenTimeEditCommand = defineCommand({
  path: ["kiten", "time", "edit"],
  errorName: "kiten time edit",
  summary: "Изменить запись учёта времени на карточке Kaiten.",
  usage:
    "mpu kiten time edit SELECTOR LOG_ID [--time DURATION] [--date D] [--role REF] [--comment TEXT] [--force]",
  help: `SELECTOR — id карточки либо её URL. LOG_ID — id записи с этой же
карточки; записи с другой карточки команда не трогает.

Обновление частичное: уходят только названные оси, остальные поля сервер
не меняет. Нужна хотя бы одна ось, иначе ошибка ввода и запроса не будет.
--comment '' очищает комментарий — это ось, а не её отсутствие.

${DURATION_HELP}

--role — id либо название роли; нечисловое значение резолвится
справочником. Цепочки «env → умолчание» здесь нет: без флага ось роли не
задана, и роль записи остаётся прежней.

Запись другого пользователя не меняется без --force. Запись без владельца
меняется без ограничений.

${ENV_KEYS}

Exit: 0 — успех; 1 — записи нет на карточке, чужая запись без --force,
ошибка API Kaiten; 2 — ошибка ввода (пустое обновление, длительность,
дата, роль, селектор, ненастроенный KITEN_API_KEY).

Пример: mpu kiten time edit 10000001 7000001 --time 2h -m 'разбор'`,
  policy: "rw",
  argsSchema: editArgsSchema,
  forms: {
    selector: { positional: "one" },
    logId: { positional: "one" },
    comment: { short: "m" },
  },
  resultSchema: editResultSchema,
  run: runKitenTimeEdit,
  render: (result) =>
    `ok: запись ${result.log.id} · ${
      axisLines(result).join(" · ")
    } · ${result.cardUrl}\n`,
});

export const kitenTimeRmCommand = defineCommand({
  path: ["kiten", "time", "rm"],
  errorName: "kiten time rm",
  summary: "Удалить запись учёта времени с карточки Kaiten.",
  usage: "mpu kiten time rm SELECTOR LOG_ID [--force]",
  help: `SELECTOR — id карточки либо её URL. LOG_ID — id записи с этой же
карточки.

Печатает удалённую запись целиком — дату, длительность, роль и
комментарий: это страховка от опечатки в id, увидеть исчезнувшее после
удаления уже негде.

Запись другого пользователя не удаляется без --force. Запись без
владельца удаляется без ограничений.

${ENV_KEYS}

Exit: 0 — успех; 1 — записи нет на карточке, чужая запись без --force,
ошибка API Kaiten; 2 — ошибка ввода (селектор, LOG_ID, ненастроенный
KITEN_API_KEY).

Пример: mpu kiten time rm 10000001 7000003`,
  policy: "rw",
  argsSchema: rmArgsSchema,
  forms: {
    selector: { positional: "one" },
    logId: { positional: "one" },
  },
  resultSchema: rmResultSchema,
  run: runKitenTimeRm,
  render: ({ log, cardUrl }) => {
    const comment = log.comment === "" ? "" : ` · «${log.comment}»`;
    return `ok: удалена запись ${log.id} · ${log.for_date} · ${
      formatDuration(log.minutes)
    } · ${roleLabel(log)}${comment} · ${cardUrl}\n`;
  },
});
