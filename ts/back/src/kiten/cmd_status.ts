/**
 * Команда `mpu kiten status` (`docs/specs/kiten-status.md`): вся моя
 * работа в Kaiten одной выдачей по всем доскам.
 *
 * Три источника собирает `./status_fetch.ts`, правила над собранным —
 * `./status_data.ts`, формы вывода — `./status_view.ts`. Здесь ход
 * команды: разбор входа, окна, запросы и выбор формы.
 */

import { z } from "@zod/zod";
import {
  type CacheDb,
  type CommandIo,
  defineCommand,
  UsageError,
} from "../command/mod.ts";
import { windowStart } from "../dates/mod.ts";
import {
  type Column,
  getCurrentUser,
  listBoardColumns,
  listCardComments,
  listCards,
  listUserActivities,
  listUserTimeLogs,
  writeBoardRows,
} from "../kaiten/mod.ts";
import {
  type AccessIo,
  asCommandError,
  cardUrl,
  kaitenAccess,
} from "./access.ts";
import { resolveRef } from "./ref.ts";
import {
  type Stage,
  STAGE_ALIASES,
  stageFromInput,
  stageMapOf,
} from "./stage.ts";
import {
  applyFilters,
  inWindow,
  mergeInputs,
  sortRows,
  type StatusRow,
  type StatusSource,
} from "./status_data.ts";
import {
  columnTitlesFor,
  FEED_ACTIONS,
  harvest,
  type StatusApi,
} from "./status_fetch.ts";
import {
  footer,
  jsonRows,
  minutesText,
  placeText,
  renderFormat,
  renderMd,
  renderUrls,
  sourceMarks,
  stagesOf,
  updatedText,
} from "./status_view.ts";

/** Порт исполнения команды. */
type StatusIo = AccessIo & Pick<CommandIo, "openCacheDb" | "progress">;

const argsSchema = z.object({
  since: z.string().default("7d").describe(
    "окно активности: <число>{s|m|h|d} или unix-ts",
  ),
  "time-since": z.string().default("365d").describe(
    "окно суммы колонки ВРЕМЯ; независимо от --since",
  ),
  out: z.enum(["matrix", "group", "json", "md", "url"]).default("matrix")
    .describe("форма вывода"),
  stage: z.string().optional().describe(
    "только один этап: queue|estimate|work|review|test|dev|preprod|done",
  ),
  board: z.string().optional().describe("доска: ID или подстрока названия"),
  source: z.enum(["assigned", "time", "activity", "touch"]).optional()
    .describe("почему карточка в выдаче"),
  only: z.enum(["open", "done"]).optional().describe(
    "только незавершённые или только завершённые",
  ),
  format: z.string().optional().describe(
    "строка на карточку; перекрывает --out",
  ),
});

const rowSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  url: z.string(),
  stage: z.string(),
  column: z.string().nullable(),
  board: z.string().nullable(),
  space: z.string().nullable(),
  lane: z.string().nullable(),
  state: z.string().nullable(),
  closed: z.boolean(),
  escalated: z.boolean(),
  due_date: z.string().nullable(),
  updated: z.string().nullable(),
  my_minutes: z.number().int(),
  sources: z.array(z.string()),
});

const resultSchema = z.object({
  rows: z.array(rowSchema).describe("строки выдачи в порядке сортировки"),
  /** Форма вывода: её выбирает вход, а печатает рендер. */
  out: z.string(),
  format: z.string().nullable(),
  /** Сумма минут окна по ролям записей; пусто — записей не было. */
  minutesByRole: z.record(z.string(), z.number()),
  /** Момент печати в unix-секундах: от него считаются «сегодня»/«вчера». */
  now: z.number().int(),
});

export type KitenStatusArgs = z.infer<typeof argsSchema>;
export type KitenStatusResult = z.infer<typeof resultSchema>;

/** Подмены для тестов: живого Kaiten и живых часов у них нет. */
export interface StatusOptions {
  readonly api?: Partial<StatusApi>;
  readonly nowSeconds?: () => number;
}

export const kitenStatusCommand = defineCommand({
  path: ["kiten", "status"],
  summary: "Вся моя работа в Kaiten одной таблицей по всем доскам.",
  usage:
    "mpu kiten status [--since 7d] [--out matrix|group|json|md|url] [--stage X] [--board REF] [--source assigned|time|activity|touch] [--only open|done] [--format TPL] [--time-since 365d]",
  help: `Собирает карточки из трёх источников и печатает их одной
выдачей: где я назначен, где списывал время и где что-то делал
(комментарий, перемещение). Ни один источник по отдельности не полон.

Два независимых окна: --since (дефолт 7d) решает, что попадёт в
выдачу, --time-since (дефолт 365d) — за какой период суммируется
колонка ВРЕМЯ. Форма обоих: <число>{s|m|h|d} или unix-ts.

--out: matrix (дефолт) — матрица «карточка × этап», group — секции по
этапам, json/md/url — машинные формы; --format перекрывает --out.
Машинные формы подвала и рамок не печатают.

Фильтры применяются после сбора, каждый независимо: --stage (алиас
queue|estimate|work|review|test|dev|preprod|done, точное имя этапа или
подстрока), --board (ID или подстрока названия), --source (touch —
карточка только из ленты действий), --only open|done.

Этап определяется по названию колонки; KITEN_STAGE_MAP (JSON «колонка →
этап») перекрывает правила для своих колонок.

Exit: 0 — успех, включая пустую выдачу; 2 — ошибки ввода; 1 — ошибки
API.

Примеры: mpu kiten status; mpu kiten status --only open;
mpu kiten status --out json --since 30d; mpu kiten status --source touch`,
  policy: "ro",
  errorName: "kiten status",
  argsSchema,
  forms: {},
  resultSchema,
  run: (args, io: StatusIo) => runKitenStatus(args, io),
  render: renderStatus,
});

/**
 * Прогон команды. Вынесено из объявления ради двух подмен — вызовов
 * Kaiten и часов: живого инстанса в тестах нет, а окна считаются от
 * текущего момента.
 */
export async function runKitenStatus(
  args: KitenStatusArgs,
  io: StatusIo,
  options: StatusOptions = {},
): Promise<KitenStatusResult> {
  const now = (options.nowSeconds ?? defaultNow)();
  const since = windowOf(args.since, "--since", now);
  const timeSince = windowOf(args["time-since"], "--time-since", now);
  const stage = args.stage === undefined ? undefined : stageArg(args.stage);
  const access = kaitenAccess(io);
  const my = await step(() => getCurrentUser(access));

  const api = liveApi(access, my.id, timeSince, now, options.api);
  using db = io.openCacheDb();
  const collected = await step(() =>
    harvest(
      api,
      { since, timeSince, now },
      my.id,
      (id) => cardUrl(access, id),
      (boardIds) =>
        columnTitlesFor(db, api, boardIds, (boardId, columns) => {
          writeBoardRows(db, "kaiten_columns", {
            boardIds: [boardId],
            rows: columns.map((column: Column) => ({
              id: column.id,
              boardId: column.boardId,
              title: column.title,
            })),
          }, now);
        }),
    )
  );

  const merged = mergeInputs(collected.inputs, collected.minutes, stageMap(io));
  const visible = merged.filter((row) => inWindow(row, since));
  const rows = sortRows(applyFilters(visible, {
    stage,
    board: args.board === undefined ? undefined : boardTitle(db, args.board),
    source: args.source as StatusSource | "touch" | undefined,
    only: args.only,
  }));

  if (!collected.feedComplete && collected.oldestFeedAt !== null) {
    // Предупреждение уходит при любой форме вывода: в json/md/url
    // выдача иначе молча выглядит полной (отклонение `fix`).
    io.progress(
      `mpu kiten status: лента действий прочитана только до ${
        collected.oldestFeedAt.slice(0, 10)
      } (предел ${
        feedLimit(since, now)
      } страниц); карточки, которые я лишь комментировал раньше этой даты,` +
        " могли не попасть в выдачу",
    );
  }
  return {
    rows: jsonRows(rows) as KitenStatusResult["rows"],
    out: args.format === undefined ? args.out : "format",
    format: args.format ?? null,
    minutesByRole: collected.minutesByRole,
    now,
  };
}

/** Печать выбранной формы; строки уже отобраны и отсортированы. */
export function renderStatus(result: KitenStatusResult): string {
  const view = viewRows(result);
  if (result.format !== null) return renderFormat(view, result.format);
  switch (result.out) {
    case "json":
      return `${JSON.stringify(result.rows, null, 2)}\n`;
    case "md":
      return renderMd(view, result.now);
    case "url":
      return renderUrls(view);
    default:
      return renderHuman(view, result);
  }
}

/** Человекочитаемые формы: матрица и секции по этапам. */
function renderHuman(
  rows: readonly StatusRow[],
  result: KitenStatusResult,
): string {
  if (rows.length === 0) return "(нет карточек)\n";
  const lines: string[] = [];
  if (result.out === "group") {
    for (const stage of stagesOf(rows)) {
      lines.push(`## ${stage}`);
      for (const row of rows.filter((item) => item.stage === stage)) {
        lines.push(`  ${line(row, result.now)}`);
      }
    }
  } else {
    const stages = stagesOf(rows);
    lines.push(`этапы: ${stages.join(" · ")}`);
    for (const row of rows) {
      const marks = stages
        .map((stage) => (row.stage === stage ? "●" : " "))
        .join(" ");
      lines.push(`${marks}  ${line(row, result.now)}`);
    }
  }
  lines.push(footer(rows, result.minutesByRole).trimEnd());
  return `${lines.join("\n")}\n`;
}

/** Одна строка человекочитаемой формы. */
function line(row: StatusRow, now: number): string {
  const id = row.escalated ? `${row.id}!` : String(row.id);
  const closed = row.closed ? " (закрыта)" : "";
  return [
    id,
    minutesText(row.myMinutes),
    updatedText(row.updated, now),
    placeText(row),
    sourceMarks(row),
    `${row.title}${closed}`,
  ].join("  ");
}

/** Строки результата в форме, которую понимают рендеры. */
function viewRows(result: KitenStatusResult): readonly StatusRow[] {
  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    url: row.url,
    stage: row.stage as Stage,
    column: row.column,
    board: row.board,
    space: row.space,
    lane: row.lane,
    state: row.state,
    closed: row.closed,
    escalated: row.escalated,
    dueDate: row.due_date,
    updated: row.updated,
    myMinutes: row.my_minutes,
    sources: row.sources as readonly StatusSource[],
    alive: !row.closed,
  }));
}

/**
 * Название доски по `REF` (`--board`): id или подстрока названия по
 * кэшу справочника (`platform/kaiten-http.md`). Фильтр сравнивает
 * названия, поэтому резолв обязателен: без него подстрока никогда бы не
 * совпала, а id не совпал бы никогда вовсе.
 */
function boardTitle(db: CacheDb, ref: string): string {
  const boards: { readonly id: number; readonly title: string }[] = [];
  for (const row of db.query("SELECT id, title FROM kaiten_boards")) {
    if (typeof row.id === "number" && typeof row.title === "string") {
      boards.push({ id: row.id, title: row.title });
    }
  }
  return resolveRef("board", boards, ref).title;
}

/** Живые вызовы Kaiten; в тестах любой из них подменяется. */
function liveApi(
  access: ReturnType<typeof kaitenAccess>,
  myId: number,
  timeSince: number,
  now: number,
  overrides: Partial<StatusApi> = {},
): StatusApi {
  return {
    cardsOfMember: () => listCards(access, { memberIds: [myId], condition: 1 }),
    cardsOfResponsible: () =>
      listCards(access, { responsibleId: myId, condition: 1 }),
    timeLogs: () =>
      listUserTimeLogs(access, myId, {
        from: isoOf(timeSince),
        to: isoOf(now),
      }),
    activities: (maxPages) =>
      listUserActivities(access, {
        actions: FEED_ACTIONS,
        maxPages,
        minCreated: isoOf(timeSince),
      }),
    commentsOf: async (cardId) =>
      (await listCardComments(access, cardId))
        .map((comment) => comment.author?.id ?? null)
        .filter((id): id is number => id !== null)
        .map((authorId) => ({ authorId })),
    columnsOf: (boardId) => listBoardColumns(access, boardId),
    ...overrides,
  };
}

/** Карта этапов из env; битый JSON — предупреждение, а не отказ (спека). */
function stageMap(io: StatusIo): Readonly<Record<string, Stage>> {
  const raw = io.envFile.get("KITEN_STAGE_MAP");
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    io.progress(
      `mpu kiten status: некорректный JSON в KITEN_STAGE_MAP: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    io.progress(
      "mpu kiten status: KITEN_STAGE_MAP должен быть JSON-объектом",
    );
    return {};
  }
  return stageMapOf(parsed as Readonly<Record<string, unknown>>);
}

/** Граница окна или отказ ввода с текстом спеки. */
function windowOf(raw: string, flag: string, now: number): number {
  const parsed = windowStart(raw, now);
  if (parsed === null) {
    throw new UsageError(
      `${flag}: ожидается <число>{s|m|h|d} или unix-ts, получено '${raw}'`,
    );
  }
  return parsed;
}

/** Этап из `--stage` или отказ ввода со списком алиасов (спека). */
function stageArg(raw: string): Stage {
  const stage = stageFromInput(raw);
  if (stage === null) {
    throw new UsageError(
      `неизвестный этап '${raw}'; допустимо: ${
        Object.keys(STAGE_ALIASES).join(", ")
      }`,
    );
  }
  return stage;
}

/** Предел страниц ленты для текста предупреждения. */
function feedLimit(since: number, now: number): number {
  const weeks = (now - since) / (7 * 86_400);
  return Math.min(12, Math.max(1, Math.round(weeks)) * 3);
}

/** Шаг, чьи отказы Kaiten становятся отказом команды (`kaiten error: …`). */
async function step<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw asCommandError(err);
  }
}

/** Момент в ISO-8601 UTC: границы окон уходят в запросы в этой форме. */
function isoOf(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function defaultNow(): number {
  return Math.floor(Date.now() / 1000);
}
