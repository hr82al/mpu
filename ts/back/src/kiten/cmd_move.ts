/**
 * Команды `mpu kiten move`, `ready` и `review`
 * (`docs/specs/kiten-move.md`): перенос карточки по трём осям и две
 * фиксированные цели поверх него.
 *
 * Три команды в одном файле, потому что общее у них всё, кроме имени
 * целевой колонки: положение «до», решение о релоге, PATCH, положение
 * «после» и строка журнала. Механика лежит в `card_move.ts`, здесь —
 * разбор ввода, порядок обращений и вывод.
 */

import { z } from "@zod/zod";
import {
  type CommandIo,
  defineCommand,
  DomainError,
  UsageError,
} from "../command/mod.ts";
import {
  type Card,
  type Column,
  getCard,
  type KaitenAccess,
  listBoardColumns,
  listBoardLanes,
  listSpaces,
  parseCardRef,
} from "../kaiten/mod.ts";
import {
  type AccessIo,
  asCommandError,
  cardUrl,
  kaitenAccess,
} from "./access.ts";
import {
  applyMove,
  type AxisTargets,
  moveDryRunLine,
  type MoveEntry,
  moveOkLine,
  type MoveOutcome,
  moveRecordOf,
  planAxisMove,
  recordMove,
} from "./card_move.ts";
import { type RefItem, resolveRef } from "./ref.ts";

/** Срез порта: доступ к Kaiten и кэш-БД под строку журнала. */
type MoveIo = AccessIo & Pick<CommandIo, "openCacheDb">;

/** Целевая колонка `ready`/`review`: ключ env-файла и умолчание. */
interface ColumnDefault {
  readonly envKey: string;
  readonly title: string;
}

const READY: ColumnDefault = { envKey: "KITEN_READY_COLUMN", title: "Готово" };
const REVIEW: ColumnDefault = {
  envKey: "KITEN_REVIEW_COLUMN",
  title: "Код-ревью",
};

const moveArgsSchema = z.object({
  selector: z.string({ error: "нужен SELECTOR: id карточки либо её URL" })
    .describe("id карточки либо её URL"),
  lane: z.string().optional().describe("дорожка: id или подстрока названия"),
  column: z.string().optional().describe("колонка: id или подстрока названия"),
  board: z.string().optional().describe("доска: id или подстрока названия"),
});

const fixedArgsSchema = z.object({
  selector: z.string({ error: "нужен SELECTOR: id карточки либо её URL" })
    .describe("id карточки либо её URL"),
  column: z.string().optional().describe(
    "целевая колонка: id или подстрока названия",
  ),
  note: z.string().optional().describe("заметка в журнал перемещений"),
  "dry-run": z.boolean().default(false).describe(
    "печать намерения; выполняются только чтения",
  ),
});

const resultSchema = z.object({
  cardUrl: z.string().describe("web-URL карточки"),
  from: z.string().describe("положение «до»: доска · колонка · дорожка"),
  to: z.string().nullable().describe(
    "положение «после» по свежему чтению; при --dry-run — null",
  ),
  relog: z.boolean().describe("перенос сводится к релог-bump"),
  column: z.object({
    id: z.number().int().describe("id целевой колонки"),
    title: z.string().describe("название целевой колонки"),
  }).nullable().describe("целевая колонка; у move без --column — null"),
  dryRun: z.boolean().describe("намерение напечатано, PATCH не отправлен"),
});

type KitenMoveArgs = z.infer<typeof moveArgsSchema>;
type KitenFixedArgs = z.infer<typeof fixedArgsSchema>;
type KitenMoveResult = z.infer<typeof resultSchema>;

/**
 * `move`: оси проверяются раньше селектора — так задан порядок отказов
 * (`kiten-move.md`, «Golden-примеры»), и обе проверки идут до сети.
 */
async function runKitenMove(
  args: KitenMoveArgs,
  io: MoveIo,
): Promise<KitenMoveResult> {
  if (
    args.lane === undefined && args.column === undefined &&
    args.board === undefined
  ) {
    throw new UsageError("нужно хотя бы одно из --lane / --column / --board");
  }
  const cardId = parseCardRef(args.selector);
  const access = kaitenAccess(io);
  return await runMove(access, io, cardId, {
    board: args.board,
    lane: args.lane,
    column: args.column,
  }, { note: "", dryRun: false });
}

/** `ready`/`review`: перенос в фиксированную колонку текущей доски. */
async function runFixedMove(
  args: KitenFixedArgs,
  io: MoveIo,
  fixed: ColumnDefault,
): Promise<KitenMoveResult> {
  const cardId = parseCardRef(args.selector);
  const access = kaitenAccess(io);
  return await runMove(access, io, cardId, {
    column: columnRef(args.column, io, fixed),
  }, { note: args.note ?? "", dryRun: args["dry-run"] });
}

/** Ссылки на оси, как их задал пользователь; незаданная — `undefined`. */
interface AxisRefs {
  readonly board?: string;
  readonly lane?: string;
  readonly column?: string;
}

/** Что знает о вызове только команда, а не механика переноса. */
interface MoveOptions {
  readonly note: string;
  readonly dryRun: boolean;
}

/**
 * Общий ход всех трёх команд: положение «до», резолв целей в скоупе
 * целевой доски, PATCH и запись журнала. Журнал пополняется только
 * после успешного финального чтения (`kiten-move.md`, «Побочные
 * эффекты»).
 */
async function runMove(
  access: KaitenAccess,
  io: MoveIo,
  cardId: number,
  refs: AxisRefs,
  options: MoveOptions,
): Promise<KitenMoveResult> {
  const url = cardUrl(access, cardId);
  const card = await read(() => getCard(access, cardId));
  const board = await targetBoard(access, card, refs.board);
  const { targets, columns } = await resolveTargets(access, board, refs);
  const made = planAxisMove(card, targets);
  const column = targets.column === null
    ? null
    : { id: targets.column.id, title: targets.column.title };
  if (options.dryRun) {
    return {
      cardUrl: url,
      from: made.from,
      to: null,
      relog: made.relogTarget !== null,
      column,
      dryRun: true,
    };
  }
  const outcome = await read(() => applyMove(access, cardId, made, columns));
  logMove(io, outcome, {
    cardUrl: url,
    fromColumn: card.columnTitle,
    note: options.note,
    movedAt: Math.floor(Date.now() / 1000),
  });
  return {
    cardUrl: url,
    from: outcome.from,
    to: outcome.to,
    relog: outcome.relog,
    column,
    dryRun: false,
  };
}

/**
 * Строка журнала после уже применённого перемещения. Отказ записи
 * называет себя: карточка к этому моменту переехала, и молчаливый
 * `SqliteError` выглядел бы отказом самого перемещения.
 */
function logMove(io: MoveIo, outcome: MoveOutcome, entry: MoveEntry): void {
  try {
    using db = io.openCacheDb();
    recordMove(db, moveRecordOf(outcome, entry));
  } catch (err) {
    throw new DomainError(
      "карточка перенесена, но строка журнала не записана",
      { cause: err },
    );
  }
}

/**
 * Доска, в скоупе которой резолвятся дорожка и колонка: явный `--board`,
 * иначе текущая доска карточки — одноимённые колонки чужих досок не
 * конфликтуют (`kiten-move.md`, «CLI-контракт»). `asked` отличает
 * запрошенную доску от подставленной: в тело PATCH идут только заданные
 * оси.
 */
async function targetBoard(
  access: KaitenAccess,
  card: Card,
  ref: string | undefined,
): Promise<RefItem & { readonly asked: boolean }> {
  if (ref !== undefined) {
    return { ...resolveRef("board", await boards(access), ref), asked: true };
  }
  if (card.boardId === null) {
    throw new UsageError("у карточки нет доски — резолвить оси не на чем");
  }
  return { id: card.boardId, title: card.boardTitle ?? "", asked: false };
}

/** Доски всех пространств одним списком: глобального списка досок нет. */
async function boards(access: KaitenAccess): Promise<readonly RefItem[]> {
  const spaces = await read(() => listSpaces(access));
  return spaces.flatMap((space) => space.boards);
}

/**
 * Цели осей и колонки целевой доски. Колонки отдаются наружу, потому
 * что тот же список нужен релогу для выбора соседа: второй его запрос
 * был бы лишним обращением к Kaiten.
 */
async function resolveTargets(
  access: KaitenAccess,
  board: RefItem & { readonly asked: boolean },
  refs: AxisRefs,
): Promise<{
  readonly targets: AxisTargets;
  readonly columns: readonly Column[];
}> {
  const lane = refs.lane === undefined ? null : resolveRef(
    "lane",
    await read(() => listBoardLanes(access, board.id)),
    refs.lane,
  );
  // Колонки нужны только заданной колонке и релогу, а релог без неё не
  // случается: без `--column` за списком команда не ходит.
  const columns = refs.column === undefined
    ? []
    : await read(() => listBoardColumns(access, board.id));
  const column = refs.column === undefined
    ? null
    : resolveRef("column", columns, refs.column);
  return {
    targets: { board: board.asked ? board : null, lane, column },
    columns,
  };
}

/** Колонка `ready`/`review`: флаг → ключ env-файла → умолчание. */
function columnRef(
  flag: string | undefined,
  io: MoveIo,
  fixed: ColumnDefault,
): string {
  if (flag !== undefined) return flag;
  const configured = io.envFile.get(fixed.envKey);
  // Пустое значение ключа равносильно его отсутствию — уходит на
  // умолчание, а не резолвится пустой подстрокой.
  return configured === undefined || configured.trim() === ""
    ? fixed.title
    : configured;
}

/** Отказ Kaiten — доменная ошибка команды: exit 1 и текст в stderr. */
async function read<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (err) {
    throw asCommandError(err);
  }
}

/** Строка вывода: намерение при `--dry-run`, иначе строка успеха. */
function renderMove(result: KitenMoveResult): string {
  if (result.dryRun) {
    // `--dry-run` бывает только у `ready`/`review`, а у них колонка
    // задана всегда: флагом, ключом env-файла либо умолчанием.
    if (result.column === null) {
      throw new TypeError("намерение без целевой колонки");
    }
    return moveDryRunLine({
      columnId: result.column.id,
      columnTitle: result.column.title,
      relog: result.relog,
      from: result.from,
    });
  }
  // Положение «после» без `--dry-run` даёт финальный GET; его отсутствие
  // значило бы, что перемещения не было, — молча выдать за успех нельзя.
  if (result.to === null) throw new TypeError("перенос без положения «после»");
  return moveOkLine({
    from: result.from,
    to: result.to,
    relog: result.relog,
  }, result.cardUrl);
}

const ENV_KEYS = `Ключи env-файла: KITEN_API_KEY, KITEN_BASE_URL`;

export const kitenMoveCommand = defineCommand({
  path: ["kiten", "move"],
  errorName: "kiten move",
  summary: "Перенести карточку Kaiten по осям доска / дорожка / колонка.",
  usage: "mpu kiten move SELECTOR [--lane REF] [--column REF] [--board REF]",
  help: `SELECTOR — id карточки либо её URL.

Нужна хотя бы одна ось; незаданные оси не меняются. REF — id или
подстрока названия: точное совпадение старше подстроки, несколько
совпадений — отказ со списком кандидатов. Дорожка и колонка резолвятся
на целевой доске (явный --board, иначе доска карточки), поэтому
одноимённые колонки чужих досок не конфликтуют.

--column с текущей колонкой карточки (и без других изменений) делает
релог-bump: перевод в соседнюю колонку и обратно. Иначе Kaiten такой
PATCH молча игнорирует и перемещение не фиксируется.

Каждое успешное перемещение пишется в локальный журнал — по нему
mpu telegram status строит дневную сводку.

stdout: ok: {до} → {после}[ (релог)] · {url карточки}.

${ENV_KEYS}.

Exit: 0 — успех; 1 — ошибка API; 2 — ошибка ввода (ни одной оси,
селектор, нерезолвящийся REF).

Пример: mpu kiten move 10000001 --column Очередь --board 'Доска поддержки'`,
  policy: "rw",
  argsSchema: moveArgsSchema,
  forms: { selector: { positional: "one" } },
  resultSchema,
  run: runKitenMove,
  render: renderMove,
});

export const kitenReadyCommand = defineCommand({
  path: ["kiten", "ready"],
  errorName: "kiten ready",
  summary: "Перевести карточку Kaiten в колонку «Готово».",
  usage: "mpu kiten ready SELECTOR [--column REF] [--note TEXT] [--dry-run]",
  help: fixedHelp(READY),
  policy: "rw",
  argsSchema: fixedArgsSchema,
  forms: { selector: { positional: "one" } },
  resultSchema,
  run: (args: KitenFixedArgs, io: MoveIo) => runFixedMove(args, io, READY),
  render: renderMove,
});

export const kitenReviewCommand = defineCommand({
  path: ["kiten", "review"],
  errorName: "kiten review",
  summary: "Перевести карточку Kaiten в колонку «Код-ревью».",
  usage: "mpu kiten review SELECTOR [--column REF] [--note TEXT] [--dry-run]",
  help: fixedHelp(REVIEW),
  policy: "rw",
  argsSchema: fixedArgsSchema,
  forms: { selector: { positional: "one" } },
  resultSchema,
  run: (args: KitenFixedArgs, io: MoveIo) => runFixedMove(args, io, REVIEW),
  render: renderMove,
});

/** Справка `ready` и `review`: у них разнятся только колонка и ключ. */
function fixedHelp(fixed: ColumnDefault): string {
  return `SELECTOR — id карточки либо её URL.

Перевод в колонку «${fixed.title}» на текущей доске карточки: дорожка и
доска не меняются. Целевая колонка — --column, иначе ключ
${fixed.envKey}, иначе «${fixed.title}»; REF это id или подстрока
названия.

Карточка уже в целевой колонке — делается релог-bump: перевод в соседнюю
колонку и обратно. Иначе Kaiten такой PATCH молча игнорирует и
перемещение не фиксируется.

После переноса карточка может оказаться на общей архивной доске готовых
карточек вместо исходной: в этой рабочей области Kaiten так и задумано —
не ошибка и не повод переносить обратно.

--note TEXT — заметка; она уходит в строку локального журнала
перемещений, по которому mpu telegram status строит дневную сводку.
--dry-run — печать намерения: только чтения, PATCH не отправляется и
журнал не пополняется.

stdout: ok: {до} → {после}[ (релог)] · {url карточки}.

${ENV_KEYS}, ${fixed.envKey}.

Exit: 0 — успех; 1 — ошибка API; 2 — ошибка ввода (селектор,
нерезолвящийся REF).

Пример: mpu kiten ${
    fixed === READY ? "ready" : "review"
  } 10000001 --note 'MR !999'`;
}
