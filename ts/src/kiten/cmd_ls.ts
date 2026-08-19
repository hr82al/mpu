/**
 * Команда `mpu kiten ls` (`docs/specs/kiten-ls.md`): список карточек
 * Kaiten, где я участник — свод фильтров по осям «CLI-флаг → env →
 * дефолт» и четыре машиночитаемых вида вывода плюс таблица по умолчанию.
 * Только чтение.
 *
 * Каждая ось фильтра сводится независимо (`buildAxes`), резолв `REF` и
 * название колонки читают локальный кэш — та же граница «команда ↔
 * каталог», что у соседей семейства: HTTP и форма ответов сервера сюда не
 * входят (`../kaiten/mod.ts`). Кэш открывается лениво и только на чтение:
 * `--json` его не касается вовсе, если входу не нужен резолв `REF`.
 */

import { z } from "@zod/zod";
import {
  type CacheDb,
  type CommandIo,
  defineCommand,
  type SqlParam,
  UsageError,
} from "../command/mod.ts";
import {
  type CardCondition,
  type CardFilter,
  type CardState,
  type CardSummary,
  getCurrentUser,
  type KaitenAccess,
  listCards,
} from "../kaiten/mod.ts";
import {
  type AccessIo,
  asCommandError,
  cardUrl,
  kaitenAccess,
} from "./access.ts";
import { stateLabel } from "./card_view.ts";
import { type RefItem, resolveRef } from "./ref.ts";
import { parseCalendarDate } from "./time_input.ts";
import {
  type LsRow,
  lsRowSchema,
  renderLsFormat,
  renderLsJson,
  renderLsMarkdown,
  renderLsOnlyUrl,
  renderLsTable,
} from "./ls_view.ts";

/** Допустимые значения `--state`, они же перечень схемы. */
const STATE_VALUES = ["queued", "in-progress", "done"] as const;

/** `--state` → `states` сервера (спека, CLI-контракт). */
const STATE_CODES: Readonly<Record<typeof STATE_VALUES[number], CardState>> = {
  "queued": 1,
  "in-progress": 2,
  "done": 3,
};

/** Только целое, со знаком — форма env-осей `KITEN_LS_*`. */
const INTEGER = /^-?\d+$/;

const argsSchema = z.object({
  archived: z.boolean().default(false).describe(
    "архивные карточки (condition=2) вместо активных",
  ),
  state: z.enum(STATE_VALUES, {
    error: `--state — одно из: ${STATE_VALUES.join(", ")}`,
  }).optional().describe("этап карточки: queued, in-progress, done"),
  space: z.string().optional().describe(
    "пространство: id или подстрока названия",
  ),
  board: z.string().optional().describe("доска: id или подстрока названия"),
  lane: z.string().optional().describe("дорожка: id или подстрока названия"),
  column: z.string().optional().describe("колонка: id или подстрока названия"),
  "date-from": z.string().optional().describe(
    "нижняя граница активности YYYY-MM-DD, включительно",
  ),
  "date_from": z.string().optional().describe("синоним --date-from"),
  "date-to": z.string().optional().describe(
    "верхняя граница активности YYYY-MM-DD, включительно",
  ),
  "date_to": z.string().optional().describe("синоним --date-to"),
  json: z.boolean().default(false).describe(
    "массив объектов id/state/due_date/updated/title/url, отступ 2",
  ),
  format: z.string().optional().describe(
    "шаблон строки на карточку: {n} {id} {title} {url} {state} {due} {column} {column_mapped}",
  ),
  "only-url": z.boolean().default(false).describe(
    "[title](url) по строке на карточку",
  ),
  md: z.boolean().default(false).describe("GFM-таблица"),
});

const resultSchema = z.object({
  view: z.enum(["json", "format", "only-url", "md", "table"]).describe(
    "вид вывода, выбранный флагами по приоритету спеки",
  ),
  rows: z.array(lsRowSchema).describe("карточки в порядке ответа сервера"),
});

/** Разобранные аргументы вызова. */
export type KitenLsArgs = z.infer<typeof argsSchema>;

/** Результат: вид вывода и уже собранные строки. */
export type KitenLsResult = z.infer<typeof resultSchema>;

type LsView = KitenLsResult["view"];

/** Срез порта: доступ к Kaiten, кэш-БД под чтение, диагностика в stderr. */
type LsIo = AccessIo & Pick<CommandIo, "openCacheDb" | "progress">;

/** Оси запроса `/cards`, кроме `memberIds` — её задаёт вызывающий. */
type RequestAxes = Omit<CardFilter, "memberIds" | "responsibleId">;

/**
 * Ленивое чтение кэша справочников: файл открывается на первом
 * обращении, не раньше (`kiten-ls.md`, «Инварианты»: `--json` от кэша не
 * зависит и его не касается, если резолв `REF` не нужен).
 */
interface CacheReader {
  readonly spaces: () => readonly RefItem[];
  readonly boards: () => readonly RefItem[];
  readonly lanes: (boardId: number | undefined) => readonly RefItem[];
  readonly columns: (boardId: number | undefined) => readonly RefItem[];
  readonly columnTitles: () => ReadonlyMap<number, string>;
  readonly close: () => void;
}

export async function runKitenLs(
  args: KitenLsArgs,
  io: LsIo,
): Promise<KitenLsResult> {
  const view = viewOf(args);
  const cache = makeCacheReader(io);
  try {
    const axes = buildAxes(args, io, cache);
    const access = kaitenAccess(io);
    const me = await read(() => getCurrentUser(access));
    const cards = await read(() =>
      listCards(access, { memberIds: [me.id], ...axes })
    );
    const columnTitles = needsColumns(view)
      ? cache.columnTitles()
      : EMPTY_TITLES;
    const columnMap = needsColumns(view) ? columnMapOf(io) : EMPTY_MAP;
    const rows = cards.map((card) =>
      toRow(card, access, columnTitles, columnMap)
    );
    return { view, rows };
  } finally {
    cache.close();
  }
}

/** Вид вывода по убыванию приоритета (спека, CLI-контракт). */
function viewOf(args: KitenLsArgs): LsView {
  if (args.json) return "json";
  if (args.format !== undefined) return "format";
  if (args["only-url"]) return "only-url";
  if (args.md) return "md";
  return "table";
}

/** Виды, печатающие колонку карточки — единственные, кому нужен её кэш. */
function needsColumns(view: LsView): boolean {
  return view === "format" || view === "md" || view === "table";
}

const EMPTY_TITLES: ReadonlyMap<number, string> = new Map();
const EMPTY_MAP: Readonly<Record<string, string>> = {};

/**
 * Свод осей запроса. Каждая — независимо: CLI-флаг → env `KITEN_LS_*` →
 * дефолт (только у `condition`). Глобальный режим (задана хотя бы одна
 * дата) отключает env-оси целиком, включая доску по умолчанию для
 * скоупа дорожки/колонки; явные CLI-флаги силу сохраняют.
 */
function buildAxes(
  args: KitenLsArgs,
  io: LsIo,
  cache: CacheReader,
): RequestAxes {
  const dateFrom = dateAxis(
    args,
    "date-from",
    "date_from",
    "--date-from",
    "--date_from",
  );
  const dateTo = dateAxis(args, "date-to", "date_to", "--date-to", "--date_to");
  const globalMode = dateFrom !== undefined || dateTo !== undefined;

  const boardId = axisId(
    args.board,
    "KITEN_LS_BOARD_ID",
    io,
    globalMode,
    (ref) => resolveRef("board", cache.boards(), ref).id,
  );

  return {
    condition: conditionAxis(args, io, globalMode),
    states: statesAxis(args, io, globalMode),
    spaceId: axisId(
      args.space,
      "KITEN_LS_SPACE_ID",
      io,
      globalMode,
      (ref) => resolveRef("space", cache.spaces(), ref).id,
    ),
    boardId,
    laneId: axisId(
      args.lane,
      "KITEN_LS_LANE_ID",
      io,
      globalMode,
      (ref) => resolveRef("lane", cache.lanes(boardId), ref).id,
    ),
    columnId: axisId(
      args.column,
      "KITEN_LS_COLUMN_ID",
      io,
      globalMode,
      (ref) => resolveRef("column", cache.columns(boardId), ref).id,
    ),
    updatedAfter: dateFrom === undefined ? undefined : `${dateFrom}T00:00:00Z`,
    updatedBefore: dateTo === undefined ? undefined : `${dateTo}T23:59:59Z`,
  };
}

/**
 * `condition`: `--archived` (→2) побеждает всегда; в глобальном режиме
 * без него ось не передаётся вовсе — ни env, ни дефолт; иначе env, а нет
 * его — дефолт 1 (спека, «Ввод/вывод» и «Инварианты»).
 */
function conditionAxis(
  args: KitenLsArgs,
  io: LsIo,
  globalMode: boolean,
): CardCondition | undefined {
  if (args.archived) return 2;
  if (globalMode) return undefined;
  const env = envInt(io, "KITEN_LS_CONDITION");
  if (env === undefined) return 1;
  // Env-ось несёт значение «как есть» (спека): домен 1|2 — локальное
  // ограничение CLI-флага, транспорт лишь подставляет число в query.
  return env as CardCondition;
}

/**
 * `states`: `--state` — единственное каноническое имя, отображённое в
 * код сервера; env `KITEN_LS_STATES` передаётся дословно, без разбора.
 */
function statesAxis(
  args: KitenLsArgs,
  io: LsIo,
  globalMode: boolean,
): readonly CardState[] | undefined {
  if (args.state !== undefined) return [STATE_CODES[args.state]];
  if (globalMode) return undefined;
  const raw = io.envFile.get("KITEN_LS_STATES");
  if (raw === undefined || raw.trim() === "") return undefined;
  // Join одноэлементного массива не добавляет разделителей — строка
  // уходит в запрос дословно, тем же приёмом, что у `condition` выше.
  return [raw] as unknown as readonly CardState[];
}

/** Числовая ось `--space`/`--board`/`--lane`/`--column`: REF → env → нет. */
function axisId(
  ref: string | undefined,
  envKey: string,
  io: LsIo,
  globalMode: boolean,
  resolve: (ref: string) => number,
): number | undefined {
  if (ref !== undefined) return resolve(ref);
  if (globalMode) return undefined;
  return envInt(io, envKey);
}

/** Целочисленная env-ось; нечисловая — отказ ввода с именем переменной. */
function envInt(io: LsIo, name: string): number | undefined {
  const raw = io.envFile.get(name);
  if (raw === undefined || raw.trim() === "") return undefined;
  if (!INTEGER.test(raw.trim())) {
    throw new UsageError(`${name}='${raw}': ожидалось целое число`);
  }
  return Number(raw.trim());
}

/** `--date-from`/`--date-to` и их написания с подчёркиванием; дефис старше. */
function dateAxis(
  args: KitenLsArgs,
  dashKey: "date-from" | "date-to",
  underscoreKey: "date_from" | "date_to",
  dashFlag: string,
  underscoreFlag: string,
): string | undefined {
  const dash = args[dashKey];
  if (dash !== undefined) return parseCalendarDate(dash, dashFlag);
  const underscore = args[underscoreKey];
  return underscore === undefined
    ? undefined
    : parseCalendarDate(underscore, underscoreFlag);
}

/** Строка выдачи из карточки списка: URL строит `access`, колонка — кэш. */
function toRow(
  card: CardSummary,
  access: KaitenAccess,
  columnTitles: ReadonlyMap<number, string>,
  columnMap: Readonly<Record<string, string>>,
): LsRow {
  const column = columnLabel(card.columnId, columnTitles);
  return {
    id: card.id,
    state: stateLabel(card.state),
    due_date: card.dueDate,
    updated: card.updated,
    title: card.title,
    url: cardUrl(access, card.id),
    column,
    columnMapped: columnMappedLabel(card.columnId, column, columnMap),
  };
}

/** `{column}`: название по кэшу; промах — id числом; колонки нет — пусто. */
function columnLabel(
  columnId: number | null,
  titles: ReadonlyMap<number, string>,
): string {
  if (columnId === null) return "";
  return titles.get(columnId) ?? String(columnId);
}

/** `{column_mapped}`: ключ-id раньше ключа-названия; не найдено — `column`. */
function columnMappedLabel(
  columnId: number | null,
  column: string,
  map: Readonly<Record<string, string>>,
): string {
  if (columnId !== null && Object.hasOwn(map, String(columnId))) {
    return map[String(columnId)];
  }
  if (column !== "" && Object.hasOwn(map, column)) return map[column];
  return column;
}

/**
 * `KITEN_COLUMN_MAP`: JSON-объект «id-или-название → метка». Некорректный
 * JSON или не-объект — не отказ команды: строка в stderr, карта пустая
 * (спека, «Граничные случаи»).
 */
function columnMapOf(io: LsIo): Readonly<Record<string, string>> {
  const raw = io.envFile.get("KITEN_COLUMN_MAP");
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    io.progress(
      `mpu kiten ls: некорректный JSON в KITEN_COLUMN_MAP: ${reasonOf(err)}`,
    );
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    io.progress("mpu kiten ls: KITEN_COLUMN_MAP должен быть JSON-объектом");
    return {};
  }
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") map[key] = value;
  }
  return map;
}

/** Отказ Kaiten — доменная ошибка команды: exit 1 и текст в stderr. */
async function read<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw asCommandError(err);
  }
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Кэш открывается на первое реальное обращение — не при создании. */
function makeCacheReader(io: LsIo): CacheReader {
  let opened: CacheDb | null = null;
  const db = (): CacheDb => {
    if (opened === null) {
      opened = io.openCacheDb();
      opened.bootstrap();
    }
    return opened;
  };
  return {
    spaces: () => refItemsOf(db(), "SELECT id, title FROM kaiten_spaces"),
    boards: () => refItemsOf(db(), "SELECT id, title FROM kaiten_boards"),
    lanes: (boardId) => scopedRefItems(db(), "kaiten_lanes", boardId),
    columns: (boardId) => scopedRefItems(db(), "kaiten_columns", boardId),
    columnTitles: () => columnTitlesOf(db()),
    close: () => {
      opened?.[Symbol.dispose]();
    },
  };
}

function refItemsOf(
  db: CacheDb,
  sql: string,
  ...params: SqlParam[]
): readonly RefItem[] {
  const items: RefItem[] = [];
  for (const row of db.query(sql, ...params)) {
    if (typeof row.id === "number" && typeof row.title === "string") {
      items.push({ id: row.id, title: row.title });
    }
  }
  return items;
}

function scopedRefItems(
  db: CacheDb,
  table: "kaiten_lanes" | "kaiten_columns",
  boardId: number | undefined,
): readonly RefItem[] {
  return boardId === undefined
    ? refItemsOf(db, `SELECT id, title FROM ${table}`)
    : refItemsOf(
      db,
      `SELECT id, title FROM ${table} WHERE board_id = ?`,
      boardId,
    );
}

function columnTitlesOf(db: CacheDb): ReadonlyMap<number, string> {
  const map = new Map<number, string>();
  for (const row of db.query("SELECT id, title FROM kaiten_columns")) {
    if (typeof row.id === "number" && typeof row.title === "string") {
      map.set(row.id, row.title);
    }
  }
  return map;
}

export const kitenLsCommand = defineCommand({
  path: ["kiten", "ls"],
  errorName: "kiten ls",
  summary: "Список карточек Kaiten, где я участник.",
  usage:
    "mpu kiten ls [--archived] [--state S] [--space REF] [--board REF] [--lane REF] [--column REF] [--date-from D] [--date-to D] [--json | --format TPL | --only-url | --md]",
  help: `Карточки, где владелец токена — участник (member).

Фильтры сводятся пооснó: CLI-флаг → env KITEN_LS_* → дефолт (он есть
только у condition — 1, активные). --archived даёт condition=2 и
побеждает env всегда.

Любая из --date-from/--date-to (принимаются и --date_from/--date_to)
включает глобальный режим: env-оси, включая KITEN_LS_BOARD_ID, не
применяются вовсе, condition не уходит без --archived. Границы окна по
updated инклюзивные: X → XT00:00:00Z, Y → YT23:59:59Z.

--space/--board/--lane/--column — id или подстрока названия; последние
две резолвятся в скоупе эффективной доски. Кэш только читается.

Виды вывода по убыванию приоритета: --json (id, state, due_date,
updated, title, url — колонки и доски там нет) → --format TPL →
--only-url → --md → таблица. Плейсхолдеры: {n} {id} {title} {url}
{state} {due} {column} {column_mapped}; неизвестный остаётся как есть.
{column} — из кэша (промах — id числом), {column_mapped} — метка из
KITEN_COLUMN_MAP; битая карта не роняет команду.

Exit: 0 — успех, в т.ч. пустая выдача; 1 — ошибка API; 2 — ошибки
ввода: дата, env-ось, --state, REF.

Пример: mpu kiten ls --date-from 2026-07-01 --json`,
  policy: "ro",
  argsSchema,
  resultSchema,
  run: runKitenLs,
  render: (result, args) => {
    switch (result.view) {
      case "json":
        return renderLsJson(result.rows);
      case "format": {
        // Вид "format" достижим только при заданном --format (`viewOf`).
        if (args.format === undefined) {
          throw new TypeError("вид format без шаблона --format");
        }
        return renderLsFormat(result.rows, args.format);
      }
      case "only-url":
        return renderLsOnlyUrl(result.rows);
      case "md":
        return renderLsMarkdown(result.rows);
      case "table":
        return renderLsTable(result.rows);
      default: {
        const unknown: never = result.view;
        throw new TypeError(`неизвестный вид вывода: ${String(unknown)}`);
      }
    }
  },
});
