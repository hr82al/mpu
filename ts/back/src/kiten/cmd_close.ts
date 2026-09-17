/**
 * Команда `mpu kiten close` (`docs/specs/kiten-close.md`): закрытие
 * карточки Kaiten одним вызовом — таймер, поля, ответ клиенту, перенос.
 * Порядок шагов фиксирован и выбран так, что самое ценное (учтённое
 * время) фиксируется первым.
 *
 * Своей механики здесь мало: остановка таймера идёт по контракту
 * `kiten-time.md`, запись полей — по `kiten-field.md` (таблица видов —
 * `./field_kinds.ts`), перенос — по `./card_move.ts`. Оркестратор
 * отвечает за порядок, за то, что ошибка ввода не стоит ни одной
 * мутации, и за то, из чего складываются строки вывода.
 */

import { z } from "@zod/zod";
import {
  type CommandIo,
  defineCommand,
  DomainError,
  readTextStdin,
  UsageError,
} from "../command/mod.ts";
import {
  type Card,
  type Column,
  createCardComment,
  getCard,
  type KaitenAccess,
  listBoardColumns,
  listCardTimeLogs,
  listUserRoles,
  parseCardRef,
  stopUserTimer,
  type Timer,
  updateCardProperties,
} from "../kaiten/mod.ts";
import {
  type AccessIo,
  asCommandError,
  asStepError,
  cardUrl,
  kaitenAccess,
} from "./access.ts";
import {
  appliedOf,
  applyMove,
  moveDryRunLine,
  moveOkLine,
  type MovePlan,
  moveRecordOf,
  planMove,
  recordMove,
} from "./card_move.ts";
import { resolveRef } from "./ref.ts";
import { expandAllInText, mentionsAll } from "./comment_text.ts";
import { type FieldKind, propertyKey } from "./field_kinds.ts";
import { MSK_OFFSET_MINUTES, mskStamp } from "./msk.ts";
import { chooseRoleId, ROLE_ENV_KEY, roleNameOf } from "./time_role.ts";
import { elapsedMinutes, isoAt, zoneOffsetMinutes } from "./timer_stamp.ts";
import { formatDuration } from "./time_view.ts";

/** Ключ env-файла с колонкой переноса по умолчанию. */
const COLUMN_ENV_KEY = "KITEN_READY_COLUMN";

/** Колонка переноса, когда её не назвали ни флагом, ни настройкой. */
const DEFAULT_COLUMN = "Готово";

/**
 * Поля в порядке обработки и вывода: он фиксирован спекой и не зависит
 * от порядка флагов в argv.
 */
const FIELD_ORDER: readonly FieldKind[] = [
  "hypothesis",
  "done",
  "result",
  "mr",
];

const fieldValue = (what: string) =>
  z.string().optional().describe(`значение поля «${what}»`);

const argsSchema = z.object({
  selector: z.string({ error: "нужен SELECTOR: id карточки или её URL" })
    .describe("id карточки либо её URL, короткий или глубокий"),
  hypothesis: fieldValue("6. Причина/гипотеза"),
  done: fieldValue("7. Что сделано"),
  result: fieldValue("8. Результат"),
  mr: fieldValue("Ссылка на Merge Request"),
  reply: z.string().optional().describe("текст ответа клиенту"),
  "reply-file": z.string().optional().describe(
    "файл с текстом ответа; '-' — stdin",
  ),
  column: z.string().optional().describe(
    "колонка переноса: id либо название; без флага — env и «Готово»",
  ),
  "force-fields": z.boolean().default(false).describe(
    "писать поля поверх заполненных",
  ),
  "no-move": z.boolean().default(false).describe("не переносить карточку"),
  "stop-timer": z.boolean().default(false).describe(
    "остановить идущий таймер и записать время",
  ),
  "dry-run": z.boolean().default(false).describe(
    "печать плана; выполняются только чтения",
  ),
});

const resultSchema = z.object({
  cardId: z.number().int().describe("id карточки, которую закрывали"),
  cardUrl: z.string().describe("адрес карточки: базовый URL и её id"),
  dryRun: z.boolean().describe("план без единой мутации"),
  timer: z.object({
    startedAt: z.string().nullable().describe(
      "метка старта; сервер её не назвал — null",
    ),
    elapsedMinutes: z.number().int().describe(
      "сколько таймер шёл на момент чтения карточки",
    ),
  }).nullable().describe("таймер, идущий на карточке; не запущен — null"),
  stopped: z.object({
    minutes: z.number().int().nullable().describe(
      "длительность созданной записи; перечитать не удалось — null",
    ),
    role: z.string().nullable().describe(
      "название роли записи; названия нет — null",
    ),
    logId: z.number().int().nullable().describe(
      "id созданной записи; сервер его не назвал — null",
    ),
  }).nullable().describe("остановка таймера этим вызовом; не было — null"),
  written: z.array(z.string()).describe(
    "поля, записанные этим вызовом, в порядке обработки",
  ),
  skipped: z.array(z.string()).describe(
    "переданные поля, пропущенные как заполненные",
  ),
  reply: z.object({
    commentId: z.number().int().nullable().describe(
      "id созданного комментария; при --dry-run — null",
    ),
    expandedTo: z.string().nullable().describe(
      "во что раскрыт '@all'; раскрытия не было — null",
    ),
  }).nullable().describe("ответ клиенту; текста ответа не было — null"),
  move: z.object({
    columnId: z.number().int().describe("id целевой колонки"),
    columnTitle: z.string().describe("название целевой колонки"),
    relog: z.boolean().describe("перенос сводится к релог-bump"),
    from: z.string().describe("положение «до»"),
    to: z.string().nullable().describe(
      "положение «после» по свежему чтению; при --dry-run — null",
    ),
  }).nullable().describe("перенос карточки; при --no-move — null"),
});

/** Разобранные аргументы вызова. */
type KitenCloseArgs = z.infer<typeof argsSchema>;

/** Результат: что запланировано либо что применено на каждом шаге. */
type KitenCloseResult = z.infer<typeof resultSchema>;

/**
 * Срез порта исполнения: доступ к Kaiten, два источника текста ответа,
 * журнал перемещений в кэш-БД и служебная строка хода.
 */
type CloseIo =
  & AccessIo
  & Pick<
    CommandIo,
    "openCacheDb" | "progress" | "readTextFile" | "readStdin"
  >;

/** Идущий таймер глазами вывода: метка старта и натёкшее время. */
type RunningTimer = NonNullable<KitenCloseResult["timer"]>;

/** Ответ клиенту: текст к отправке и след раскрытия `@all` для вывода. */
interface Reply {
  readonly text: string;
  readonly expandedTo: string | null;
}

/** Поле к записи: вид и значение, которое уйдёт на сервер. */
interface FieldWrite {
  readonly kind: FieldKind;
  readonly value: string;
}

/** Что команда собирается сделать: решено до первой мутации. */
interface ClosePlan {
  readonly card: Card;
  readonly reply: Reply | null;
  readonly write: readonly FieldWrite[];
  readonly skip: readonly FieldKind[];
  readonly move: MovePlan | null;
  /** Колонки доски: нужны релогу; переноса нет — пустой список. */
  readonly columns: readonly Column[];
}

/**
 * Закрывает карточку. Весь план строится до первой мутации: ошибка
 * ввода — включая неверную колонку — не должна стоить ни остановленного
 * таймера, ни отправленного комментария (`kiten-close.md`, «Известные
 * отклонения», вердикт fix).
 */
async function runKitenClose(
  args: KitenCloseArgs,
  io: CloseIo,
): Promise<KitenCloseResult> {
  const cardId = parseCardRef(args.selector);
  const reply = await readReply(args, io);
  const access = kaitenAccess(io);
  const plan = await buildPlan(access, cardId, args, reply, io);
  const url = cardUrl(access, cardId);
  const timer = timerView(plan.card.timer);
  if (args["dry-run"]) return planResult(cardId, url, plan, timer);
  return {
    ...planResult(cardId, url, plan, timer),
    dryRun: false,
    ...await applyPlan(access, cardId, url, plan, args, io),
  };
}

/**
 * План: стартовое чтение карточки, раскрытие `@all` по её владельцу,
 * отбор полей к записи и резолв колонки переноса. Мутаций нет ни одной,
 * поэтому этот же путь целиком проходит `--dry-run`.
 */
async function buildPlan(
  access: KaitenAccess,
  cardId: number,
  args: KitenCloseArgs,
  reply: string | null,
  io: CloseIo,
): Promise<ClosePlan> {
  // Ошибка стартового чтения идёт без маркера шага: шага ещё не было.
  const card = await getCard(access, cardId).catch((err) => {
    throw asCommandError(err);
  });
  const columns = args["no-move"] ? [] : await boardColumns(access, card);
  return {
    card,
    reply: reply === null ? null : expandReply(reply, card, io),
    write: FIELD_ORDER.flatMap((kind) => {
      const value = args[kind];
      if (value === undefined) return [];
      const empty = isBlank(card.properties[propertyKey(kind)]);
      return args["force-fields"] || empty ? [{ kind, value }] : [];
    }),
    skip: FIELD_ORDER.filter((kind) =>
      args[kind] !== undefined && !args["force-fields"] &&
      !isBlank(card.properties[propertyKey(kind)])
    ),
    move: args["no-move"]
      ? null
      : planMove(card, resolveRef("column", columns, columnRef(args, io))),
    columns,
  };
}

/**
 * Шаги в фиксированном порядке: таймер → поля → ответ → перенос.
 * Сквозного отката нет — у Kaiten нет транзакций, поэтому сбой позднего
 * шага оставляет ранние применёнными, а повторный запуск идемпотентно
 * доводит остальное (`kiten-close.md`, «Известные отклонения», вердикт
 * preserve).
 */
async function applyPlan(
  access: KaitenAccess,
  cardId: number,
  url: string,
  plan: ClosePlan,
  args: KitenCloseArgs,
  io: CloseIo,
): Promise<Partial<KitenCloseResult>> {
  const stopped = await stopTimerStep(
    access,
    cardId,
    plan.card.timer,
    args,
    io,
  );
  await writeFieldsStep(access, cardId, plan);
  const commentId = await replyStep(access, cardId, plan.reply);
  return {
    stopped,
    reply: plan.reply === null
      ? null
      : { commentId, expandedTo: plan.reply.expandedTo },
    move: await moveStep(access, cardId, url, plan, io),
  };
}

/**
 * Остановка таймера — только по флагу и только если таймер идёт: запись
 * учёта времени не создаётся побочным эффектом закрытия (инвариант
 * спеки). Роль записи — контракт `kiten-time.md` («stop»): env → дефолт,
 * локального состояния у команд нет.
 */
async function stopTimerStep(
  access: KaitenAccess,
  cardId: number,
  timer: Timer | null,
  args: KitenCloseArgs,
  io: CloseIo,
): Promise<KitenCloseResult["stopped"]> {
  if (timer === null) return null;
  if (!args["stop-timer"]) {
    io.progress(`внимание: ${timerRunningBody(cardId, runningView(timer))}`);
    return null;
  }
  try {
    const roles = await listUserRoles(access);
    const roleId = chooseRoleId(roles, undefined, io.envFile.get(ROLE_ENV_KEY));
    const stopped = await stopUserTimer(access, timer.id, {
      // Комментарий таймера сам сервер в запись не переносит, поэтому
      // уходит в запрос всегда (`kiten-time.md`, «stop»).
      comment: timer.comment,
      finishedAt: isoAt(Date.now(), zoneOf(timer.startedAt)),
      roleId,
    });
    const logId = stopped.cardTimeLogId;
    const log = logId === null
      ? undefined
      : (await listCardTimeLogs(access, cardId)).find((it) => it.id === logId);
    return {
      minutes: log?.timeSpent ?? null,
      role: log === undefined ? null : roleNameOf(roles, log.roleId),
      logId,
    };
  } catch (err) {
    throw asStepError("таймер", err);
  }
}

/**
 * Поля пишутся по одному и по порядку: пара «поле + значение» — тот же
 * запрос, что у `field set` (`kiten-field.md`). Сбой в середине
 * оставляет записанное записанным, и в гонке запросов этого было бы не
 * сказать.
 */
async function writeFieldsStep(
  access: KaitenAccess,
  cardId: number,
  plan: ClosePlan,
): Promise<void> {
  try {
    for (const field of plan.write) {
      await updateCardProperties(access, cardId, {
        [propertyKey(field.kind)]: field.value,
      });
    }
  } catch (err) {
    throw asStepError("поля", err);
  }
}

/** Ответ клиенту — комментарий без вложений; текста нет — шага нет. */
async function replyStep(
  access: KaitenAccess,
  cardId: number,
  reply: Reply | null,
): Promise<number | null> {
  if (reply === null) return null;
  try {
    return (await createCardComment(access, cardId, reply.text)).id;
  } catch (err) {
    throw asStepError("ответ", err);
  }
}

/**
 * Перенос: PATCH (у релога — два) и строка журнала перемещений с пустой
 * заметкой. Ошибки шага идут форматом `kiten-move.md`, без маркера:
 * своей команды у переноса пока нет, но и своего шага в тексте он не
 * называет.
 */
async function moveStep(
  access: KaitenAccess,
  cardId: number,
  url: string,
  plan: ClosePlan,
  io: CloseIo,
): Promise<KitenCloseResult["move"]> {
  if (plan.move === null) return null;
  const outcome = await applyMove(
    access,
    cardId,
    appliedOf(plan.move),
    plan.columns,
  )
    .catch((err) => {
      throw asCommandError(err);
    });
  using db = io.openCacheDb();
  recordMove(
    db,
    moveRecordOf(outcome, {
      cardUrl: url,
      fromColumn: plan.card.columnTitle,
      note: "",
      movedAt: Math.floor(Date.now() / 1000),
    }),
  );
  return { ...plan.move, to: outcome.to };
}

/** Результат плана; применение дописывает поверх него свои поля. */
function planResult(
  cardId: number,
  url: string,
  plan: ClosePlan,
  timer: KitenCloseResult["timer"],
): KitenCloseResult {
  return {
    cardId,
    cardUrl: url,
    dryRun: true,
    timer,
    stopped: null,
    written: plan.write.map((field) => field.kind),
    skipped: [...plan.skip],
    reply: plan.reply === null
      ? null
      : { commentId: null, expandedTo: plan.reply.expandedTo },
    move: plan.move === null ? null : { ...plan.move, to: null },
  };
}

/**
 * Текст ответа: ровно один источник, пустой текст отвергается. Всё это —
 * до первого сетевого запроса: отбитый ввод не должен стоить ни одного
 * обращения к внешней системе (`kiten-close.md`, «Ввод/вывод»).
 */
async function readReply(
  args: KitenCloseArgs,
  io: CloseIo,
): Promise<string | null> {
  const path = args["reply-file"];
  if (args.reply !== undefined && path !== undefined) {
    throw new UsageError("--reply и --reply-file взаимоисключающи");
  }
  const text = args.reply ?? (path === undefined ? null : await readReplyFile(
    io,
    path,
  ));
  if (text === null) return null;
  if (text.trim() === "") throw new UsageError("пустой текст ответа");
  return text;
}

async function readReplyFile(io: CloseIo, path: string): Promise<string> {
  try {
    return path === "-" ? await readTextStdin(io) : await io.readTextFile(path);
  } catch (err) {
    throw new UsageError(`не удалось прочитать ${path}: ${reason(err)}`, {
      cause: err,
    });
  }
}

/**
 * Раскрытие `@all` во владельца карточки. Владельца или его логина нет —
 * это не ошибка: предупреждение в stderr и литеральный `@all` в тексте.
 * Предупреждение печатается и при `--dry-run`: раскрытие считается на
 * плане, значит и предупреждение о нём — часть плана.
 */
function expandReply(text: string, card: Card, io: CloseIo): Reply {
  if (!mentionsAll(text)) return { text, expandedTo: null };
  const username = card.owner?.username ?? "";
  if (username === "") {
    io.progress(
      "mpu kiten close: у карточки нет владельца — '@all' оставлен как есть",
    );
    return { text, expandedTo: null };
  }
  const handle = `@${username}`;
  return { text: expandAllInText(text, handle), expandedTo: handle };
}

/** Колонки доски карточки: по ним резолвится цель и ищется сосед релога. */
function boardColumns(
  access: KaitenAccess,
  card: Card,
): Promise<readonly Column[]> {
  if (card.boardId === null) {
    throw new DomainError("у карточки нет доски — переносить некуда");
  }
  return listBoardColumns(access, card.boardId).catch((err) => {
    throw asCommandError(err);
  });
}

/** Колонка переноса: флаг → ключ env-файла → «Готово». */
function columnRef(args: KitenCloseArgs, io: CloseIo): string {
  if (args.column !== undefined) return args.column;
  const configured = io.envFile.get(COLUMN_ENV_KEY);
  // Пустое значение ключа равносильно его отсутствию — уходит на
  // умолчание, а не резолвится пустой подстрокой.
  return configured === undefined || configured.trim() === ""
    ? DEFAULT_COLUMN
    : configured;
}

/** Пусто ли значение поля карточки: значения нет либо одни пробелы. */
function isBlank(value: string | readonly string[] | undefined): boolean {
  if (value === undefined) return true;
  return typeof value === "string" ? value.trim() === "" : value.length === 0;
}

/** Идущий таймер глазами вывода; таймера нет — `null`. */
function timerView(timer: Timer | null): KitenCloseResult["timer"] {
  return timer === null ? null : runningView(timer);
}

/** То же для таймера, который заведомо идёт: натёкшее считается сейчас. */
function runningView(timer: Timer): RunningTimer {
  const beganMs = momentOf(timer.startedAt);
  return {
    startedAt: timer.startedAt,
    elapsedMinutes: beganMs === null ? 0 : elapsedMinutes(beganMs, Date.now()),
  };
}

/** Зона метки старта; её в метке нет — московская, зона записей компании. */
function zoneOf(startedAt: string | null): number {
  const zone = startedAt === null ? null : zoneOffsetMinutes(startedAt);
  return zone ?? MSK_OFFSET_MINUTES;
}

/** Момент ISO-метки; метки нет или она неразборна — `null`. */
function momentOf(iso: string | null): number | null {
  if (iso === null) return null;
  const atMs = Date.parse(iso);
  return Number.isNaN(atMs) ? null : atMs;
}

/** Причина отказа одной строкой: для текста ошибки ввода. */
function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Тело громкого предупреждения о таймере, который команда не трогала.
 * Оно же — строка таймера в плане: план обязан сказать ровно то, что
 * скажет применение (`kiten-close.md`, «Ввод/вывод»).
 */
function timerRunningBody(
  cardId: number,
  timer: RunningTimer,
): string {
  return `на карточке запущен таймер (${since(timer)}); он НЕ остановлен — ` +
    `\`mpu kiten time stop ${cardId}\` (или --stop-timer)`;
}

/** «с 14.08 19:50 МСК, 1 мин»; метки старта нет — «с ?», без длительности. */
function since(timer: RunningTimer): string {
  const beganMs = momentOf(timer.startedAt);
  if (beganMs === null) return "с ?";
  return `с ${mskStamp(beganMs)} МСК, ${formatDuration(timer.elapsedMinutes)}`;
}

/** Строка полей: что записано и что пропущено как заполненное. */
function fieldsLine(result: KitenCloseResult): string {
  const written = result.written.length === 0 ? "—" : result.written.join(", ");
  const skipped = result.skipped.length === 0
    ? ""
    : `; пропущены (заполнены) [${result.skipped.join(", ")}]`;
  return `[${written}]${skipped}`;
}

/** След раскрытия `@all` в строках ответа; раскрытия не было — пусто. */
function expansion(reply: NonNullable<KitenCloseResult["reply"]>): string {
  return reply.expandedTo === null ? "" : ` (@all → ${reply.expandedTo})`;
}

/** План: что команда сделала бы, без единой мутации. */
function renderPlan(result: KitenCloseResult, args: KitenCloseArgs): string {
  const lines = [
    `dry-run close · ${result.cardUrl}`,
    `  таймер: ${plannedTimer(result, args)}`,
    `  поля: записать ${fieldsLine(result)}`,
    `  ответ: ${
      result.reply === null
        ? "без ответа"
        : `запостить${expansion(result.reply)}`
    }`,
  ];
  const move = result.move === null
    ? "  перенос: пропущен (--no-move)\n"
    : moveDryRunLine(result.move);
  return `${lines.join("\n")}\n${move}`;
}

/** Строка таймера в плане: три состояния, четвёртого у таймера нет. */
function plannedTimer(
  result: KitenCloseResult,
  args: KitenCloseArgs,
): string {
  const timer = result.timer;
  if (timer === null) return "не запущен";
  if (!args["stop-timer"]) return timerRunningBody(result.cardId, timer);
  return `остановить (запущен ${since(timer)})`;
}

/** Применение: строка на команду и по строке на выполненный шаг. */
function renderApplied(result: KitenCloseResult): string {
  const lines = [`ok close: поля ${fieldsLine(result)}`];
  const stopped = result.stopped;
  if (stopped !== null) {
    const parts = [
      stopped.minutes === null ? "" : formatDuration(stopped.minutes),
      stopped.role ?? "",
      stopped.logId === null ? "" : `запись ${stopped.logId}`,
    ].filter((part) => part !== "");
    // Сказать нечего — но сказать надо: таймер остановлен, запись
    // создана, и молчание строки не отличалось бы от нетронутого
    // таймера. Так же поступает `time stop`, когда сервер не назвал id
    // записи (`kiten-time.md`).
    lines.push(
      parts.length === 0
        ? "   таймер: остановлен"
        : `   таймер: ${parts.join(" · ")}`,
    );
  }
  if (result.reply !== null) {
    lines.push(
      `   ответ: комментарий ${result.reply.commentId}${
        expansion(result.reply)
      }`,
    );
  }
  const move = result.move === null || result.move.to === null
    ? ""
    : moveOkLine({ ...result.move, to: result.move.to }, result.cardUrl);
  return `${lines.join("\n")}\n${move}`;
}

export const kitenCloseCommand = defineCommand({
  path: ["kiten", "close"],
  errorName: "kiten close",
  summary: "Закрыть карточку Kaiten: поля, ответ клиенту, перенос в «Готово».",
  usage:
    "mpu kiten close SELECTOR [--hypothesis TEXT] [--done TEXT] [--result TEXT] [--mr URL] [--reply TEXT | --reply-file PATH] [--column REF] [--force-fields] [--no-move] [--stop-timer] [--dry-run]",
  help: `SELECTOR — id карточки либо её URL.

Шаги: таймер → поля → ответ → перенос. Отката нет: сбой позднего шага
оставляет ранние применёнными, повтор безопасен.

--hypothesis/--done/--result/--mr — значения полей. Пишутся только
переданные и только в пустое поле; заполненное пропускается,
--force-fields перезаписывает. Порядок: hypothesis, done, result, mr.

Ответ — один источник: --reply TEXT либо --reply-file PATH ('-' —
stdin), пустой текст отвергается. Самостоятельный '@all' раскрывается в
логин владельца; владельца нет — предупреждение и '@all' как есть.

--column REF — колонка переноса (id либо название), иначе ключ
${COLUMN_ENV_KEY}, иначе «${DEFAULT_COLUMN}»; резолвится на доске карточки
до первой мутации. --no-move — не переносить.

--stop-timer — остановить идущий таймер и записать время (роль: ключ
${ROLE_ENV_KEY} → 12058). Без флага таймер не трогается никогда, о
запущенном команда предупреждает.

--dry-run — печать плана: только чтения.

Ключи env-файла: KITEN_API_KEY, KITEN_BASE_URL,
${COLUMN_ENV_KEY}, ${ROLE_ENV_KEY}.

Exit: 0 — успех; 1 — ошибка API (назван упавший шаг); 2 — ошибка ввода
(селектор, источники ответа, колонка, ключ доступа).

Пример: mpu kiten close 10000001 --done 'Починили' --reply-file - --stop-timer`,
  policy: "rw",
  argsSchema,
  forms: { selector: { positional: "one" } },
  resultSchema,
  run: runKitenClose,
  render: (result, args) =>
    result.dryRun ? renderPlan(result, args) : renderApplied(result),
});
