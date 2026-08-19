/**
 * Справочные подкоманды `mpu kiten` (`docs/specs/kiten-refs.md`):
 * `whoami`, `spaces`, `boards`, `lanes`, `columns`, `roles`. Каждая
 * делает живой запрос к Kaiten, печатает ответ и попутно обновляет
 * локальный кэш справочников, на котором работает резолв `REF` у всего
 * семейства.
 *
 * Шесть команд в одном файле, потому что общее у них всё, кроме вызова
 * каталога и вида таблицы: доступ, порядок «ответ → кэш → фильтр →
 * вывод» и форма отказов. Оформление вывода — `refs_view.ts`, запросы —
 * каталог `../kaiten/mod.ts`; о HTTP и форме ответов сервера команды не
 * знают.
 */

import { z } from "@zod/zod";
import {
  type CacheDb,
  type CommandIo,
  defineCommand,
  DomainError,
} from "../command/mod.ts";
import {
  type Board,
  getCurrentUser,
  type KaitenAccess,
  type KaitenRole,
  type KaitenWarmup,
  listBoardColumns,
  listBoardLanes,
  listSpaces,
  listUserRoles,
  type Space,
  writeBoardRows,
  writeKaitenWarmup,
} from "../kaiten/mod.ts";
import { type AccessIo, asCommandError, kaitenAccess } from "./access.ts";
import { resolveRef } from "./ref.ts";
import {
  type BoardRowView,
  boardRowViewSchema,
  type BoardView,
  boardViewSchema,
  renderBoardRowsTable,
  renderBoardsTable,
  renderRefsJson,
  renderRolesTable,
  renderSpacesTable,
  renderWhoami,
  type RoleView,
  roleViewSchema,
  type SpaceView,
  spaceViewSchema,
  type UserView,
  userViewSchema,
} from "./refs_view.ts";

/**
 * Строки дорожек либо колонок обойдённых досок — вход scoped-замены
 * кэша. Тип берётся у прогрева, а не объявляется заново: разошедшаяся
 * копия не собралась бы с `writeKaitenWarmup`.
 */
type BoardRows = NonNullable<KaitenWarmup["lanes"]>;

/** Строка дорожки либо колонки в кэше. */
type BoardRow = BoardRows["rows"][number];

/** Срез порта: доступ к Kaiten плюс кэш-БД под запись справочников. */
type RefsIo = AccessIo & Pick<CommandIo, "openCacheDb">;

const jsonFlag = z.boolean().default(false).describe(
  "машиночитаемый JSON: отступ 2, порядок строк — как в ответе API",
);

const whoamiArgsSchema = z.object({ json: jsonFlag });

const spacesArgsSchema = z.object({
  all: z.boolean().default(false).describe("показать и архивные пространства"),
  json: jsonFlag,
});

const boardsArgsSchema = z.object({
  space: z.string().optional().describe(
    "пространство: id или подстрока названия",
  ),
  json: jsonFlag,
});

const boardRowsArgsSchema = z.object({
  space: z.string().optional().describe(
    "пространство: id или подстрока названия",
  ),
  board: z.string().optional().describe("доска: id или подстрока названия"),
  json: jsonFlag,
});

const rolesArgsSchema = z.object({
  all: z.boolean().default(false).describe(
    "показать и системные роли с неположительным id",
  ),
  json: jsonFlag,
});

const whoamiResultSchema = z.object({
  user: userViewSchema.describe("владелец токена"),
});

const spacesResultSchema = z.object({
  spaces: z.array(spaceViewSchema).describe(
    "пространства в порядке ответа API; без --all архивные отфильтрованы",
  ),
});

const boardsResultSchema = z.object({
  boards: z.array(boardViewSchema).describe(
    "доски всех пространств плоско, в порядке ответа API",
  ),
});

const lanesResultSchema = z.object({
  lanes: z.array(boardRowViewSchema).describe(
    "дорожки досок скоупа в порядке обхода досок",
  ),
});

const columnsResultSchema = z.object({
  columns: z.array(boardRowViewSchema).describe(
    "колонки досок скоупа в порядке обхода досок",
  ),
});

const rolesResultSchema = z.object({
  roles: z.array(roleViewSchema).describe(
    "роли компании в порядке ответа API; без --all системные отфильтрованы",
  ),
});

type WhoamiArgs = z.infer<typeof whoamiArgsSchema>;
type SpacesArgs = z.infer<typeof spacesArgsSchema>;
type BoardsArgs = z.infer<typeof boardsArgsSchema>;
type BoardRowsArgs = z.infer<typeof boardRowsArgsSchema>;
type RolesArgs = z.infer<typeof rolesArgsSchema>;

/** Владелец токена: единственная подкоманда семейства без кэша. */
async function runWhoami(
  _args: WhoamiArgs,
  io: AccessIo,
): Promise<{ readonly user: UserView }> {
  const access = kaitenAccess(io);
  const user = await read(() => getCurrentUser(access));
  return {
    user: {
      id: user.id,
      full_name: user.fullName,
      username: user.username,
      email: user.email,
    },
  };
}

/**
 * Пространства. Фильтр архивных — только на выводе: в кэш уходит полный
 * ответ (`kiten-refs.md`, «Инварианты»).
 */
async function runSpaces(
  args: SpacesArgs,
  io: RefsIo,
): Promise<{ readonly spaces: readonly SpaceView[] }> {
  const spaces = await warmSpaces(kaitenAccess(io), io);
  const shown = args.all ? spaces : spaces.filter((space) => !space.archived);
  return { spaces: shown.map(spaceView) };
}

/** Доски всех пространств плоско; `--space` сужает уже полученный ответ. */
async function runBoards(
  args: BoardsArgs,
  io: RefsIo,
): Promise<{ readonly boards: readonly BoardView[] }> {
  const spaces = await warmSpaces(kaitenAccess(io), io);
  const boards = spaces.flatMap((space) => space.boards);
  const shown = args.space === undefined
    ? boards
    : boardsOfSpace(spaces, boards, args.space);
  return { boards: shown.map(boardView) };
}

/** Дорожки досок скоупа. */
async function runLanes(
  args: BoardRowsArgs,
  io: RefsIo,
): Promise<{ readonly lanes: readonly BoardRowView[] }> {
  const access = kaitenAccess(io);
  // Пространства нужны только скоупу: их запись в кэш сделал `scope`.
  const { boards } = await scope(access, io, args);
  const lanes = await visitBoards(
    boards,
    (boardId) => listBoardLanes(access, boardId),
  );
  // Пространства и доски записаны до резолва `REF` (`scope` → `warmSpaces`),
  // поэтому здесь пишется только своя таблица — второй полной перезаписи
  // тех же двух таблиц за вызов быть не должно.
  writeCache(io, (db, at) => writeBoardRows(db, "kaiten_lanes", lanes, at));
  return { lanes: lanes.rows.map(boardRowView) };
}

/** Колонки досок скоупа; скоуп и обход — те же, что у дорожек. */
async function runColumns(
  args: BoardRowsArgs,
  io: RefsIo,
): Promise<{ readonly columns: readonly BoardRowView[] }> {
  const access = kaitenAccess(io);
  const { boards } = await scope(access, io, args);
  const columns = await visitBoards(
    boards,
    async (boardId) =>
      (await listBoardColumns(access, boardId)).map(
        ({ id, boardId: board, title }): BoardRow => ({
          id,
          boardId: board,
          title,
        }),
      ),
  );
  writeCache(io, (db, at) => writeBoardRows(db, "kaiten_columns", columns, at));
  return { columns: columns.rows.map(boardRowView) };
}

/**
 * Роли компании. Системная роль скрыта по признаку `id <= 0`, а не по
 * названию: имя у неё зависит от языка компании, знак id — нет.
 */
async function runRoles(
  args: RolesArgs,
  io: RefsIo,
): Promise<{ readonly roles: readonly RoleView[] }> {
  const access = kaitenAccess(io);
  const roles = await read(() => listUserRoles(access));
  writeCache(io, (db, at) => writeRoles(db, roles, at));
  const shown = args.all ? roles : roles.filter((role) => role.id > 0);
  return { roles: shown.map(({ id, name }) => ({ id, name })) };
}

/**
 * Пространства с досками: живой ответ и сразу же его запись в кэш. Кэш
 * обновляется до резолва `REF` — спека требует резолвить по кэшу,
 * который команда обновила в начале собственного запуска.
 */
async function warmSpaces(
  access: KaitenAccess,
  io: RefsIo,
): Promise<readonly Space[]> {
  const spaces = await read(() => listSpaces(access));
  writeCache(
    io,
    (db, at) => writeKaitenWarmup(db, refsWarmup(spaces, NO_BOARD_ROWS), at),
  );
  return spaces;
}

/** Доски скоупа `lanes`/`columns` и пространства, из которых он получен. */
async function scope(
  access: KaitenAccess,
  io: RefsIo,
  args: BoardRowsArgs,
): Promise<{
  readonly spaces: readonly Space[];
  readonly boards: readonly Board[];
}> {
  const spaces = await warmSpaces(access, io);
  const boards = spaces.flatMap((space) => space.boards);
  if (args.board !== undefined) {
    return { spaces, boards: [resolveRef("board", boards, args.board)] };
  }
  if (args.space !== undefined) {
    return { spaces, boards: boardsOfSpace(spaces, boards, args.space) };
  }
  return { spaces, boards };
}

/** Доски одного пространства; ссылка не резолвится — ошибка ввода. */
function boardsOfSpace(
  spaces: readonly Space[],
  boards: readonly Board[],
  ref: string,
): readonly Board[] {
  const space = resolveRef("space", spaces, ref);
  return boards.filter((board) => board.spaceId === space.id);
}

/**
 * Обход досок скоупа: доска, ответившая ошибкой, молча пропускается, и
 * обход продолжается (`kiten-refs.md`, «Граничные случаи»: отказавшая
 * доска не роняет команду, отказ всех досок даёт пустую выдачу, а не
 * ошибку). Пропущенная доска не попадает в `boardIds` — её строки в кэше
 * остаются прежними, а не стираются недополученным ответом.
 */
async function visitBoards(
  boards: readonly Board[],
  fetchRows: (boardId: number) => Promise<readonly BoardRow[]>,
): Promise<BoardRows> {
  const outcomes = await Promise.allSettled(
    boards.map((board) => fetchRows(board.id)),
  );
  const boardIds: number[] = [];
  const rows: BoardRow[] = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === "rejected") return;
    boardIds.push(boards[index].id);
    rows.push(...outcome.value);
  });
  return { boardIds, rows };
}

/** Части прогрева, которых команда не обходила: их таблицы не трогаются. */
const NO_BOARD_ROWS = { lanes: null, columns: null } as const;

/**
 * Ответ `/spaces` в форме прогрева. Роли всегда `null`: их таблицу
 * трогает только `roles`, а полная замена пустым списком стёрла бы кэш
 * ролей на каждой соседней подкоманде.
 */
function refsWarmup(
  spaces: readonly Space[],
  rows: {
    readonly lanes: BoardRows | null;
    readonly columns: BoardRows | null;
  },
): KaitenWarmup {
  return {
    spaces: spaces.map(({ id, title, archived }) => ({ id, title, archived })),
    boards: spaces.flatMap((space) => space.boards),
    lanes: rows.lanes,
    columns: rows.columns,
    roles: null,
    skips: [],
    notes: [],
  };
}

/**
 * Полная замена таблицы ролей. Своим запросом, а не через
 * `writeKaitenWarmup`: тот в одной транзакции с любой частью переписывает
 * ещё и пространства с досками, а `roles` их не запрашивает — пустой
 * ответ стёр бы кэш, которого команда не касалась.
 */
function writeRoles(
  db: CacheDb,
  roles: readonly KaitenRole[],
  discoveredAt: number,
): void {
  db.transaction(() => {
    db.execute("DELETE FROM kaiten_roles");
    for (const role of roles) {
      db.execute(
        "INSERT INTO kaiten_roles (id, name, discovered_at) VALUES (?, ?, ?)",
        role.id,
        role.name,
        discoveredAt,
      );
    }
  });
}

/**
 * Запись кэша справочников. Её сбой не роняет команду трейсбеком, а
 * становится отказом домена в том же формате, что и отказ API
 * (`kiten-refs.md`, «Побочные эффекты»).
 */
function writeCache(
  io: RefsIo,
  write: (db: CacheDb, discoveredAt: number) => void,
): void {
  try {
    using db = io.openCacheDb();
    db.bootstrap();
    write(db, Math.floor(Date.now() / 1000));
  } catch (err) {
    throw new DomainError(
      `kaiten error: кэш справочников не записан: ${reasonOf(err)}`,
      { cause: err },
    );
  }
}

/** Отказ каталога — доменная ошибка команды: exit 1 и строка в stderr. */
async function read<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw asCommandError(err);
  }
}

/** Причина отказа одной строкой: у наших ошибок это всегда `message`. */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function spaceView(space: Space): SpaceView {
  return { id: space.id, title: space.title, archived: space.archived };
}

function boardView(board: Board): BoardView {
  return { id: board.id, space_id: board.spaceId, title: board.title };
}

function boardRowView(row: BoardRow): BoardRowView {
  return { id: row.id, board_id: row.boardId, title: row.title };
}

/** Общий хвост подробной справки: ключи env-файла и коды выхода. */
const COMMON_HELP = `Ключи env-файла: KITEN_API_KEY (обязателен),
KITEN_BASE_URL (по умолчанию https://btlz.kaiten.ru).

Exit: 0 — успех, в том числе пустая выдача; 1 — ошибка API Kaiten либо
записи кэша; 2 — ошибки ввода: не задан KITEN_API_KEY, не резолвится
REF.`;

/** Общий хвост справки подкоманд со скоупом досок. */
const SCOPE_HELP = `REF — id либо подстрока названия без учёта регистра;
точное совпадение старше подстроки, неоднозначная подстрока — ошибка
ввода со списком кандидатов.

Доска, ответившая ошибкой (нет доступа и т.п.), молча пропускается:
остальные доски остаются в выдаче, отказ всех досок даёт пустую выдачу и
exit 0.`;

export const kitenWhoamiCommand = defineCommand({
  path: ["kiten", "whoami"],
  errorName: "kiten whoami",
  summary: "Владелец токена Kaiten: id, имя, логин, почта.",
  usage: "mpu kiten whoami [--json]",
  help: `Кто я по ключу KITEN_API_KEY: один запрос к Kaiten, без записи
куда бы то ни было.

Без --json — четыре строки id/name/login/email; с --json — объект с теми
же четырьмя ключами.

${COMMON_HELP}

Пример: mpu kiten whoami --json`,
  policy: "ro",
  argsSchema: whoamiArgsSchema,
  resultSchema: whoamiResultSchema,
  run: runWhoami,
  render: (result, args) =>
    args.json ? renderRefsJson(result.user) : renderWhoami(result.user),
});

export const kitenSpacesCommand = defineCommand({
  path: ["kiten", "spaces"],
  errorName: "kiten spaces",
  summary: "Пространства компании; архивные — по --all.",
  usage: "mpu kiten spaces [--all] [--json]",
  help: `Живой список пространств; он же обновляет кэш справочников, на
котором резолвятся --space и --board у соседних команд.

--all показывает архивные пространства. Фильтр действует только на
вывод: в кэш всегда попадает полный ответ.

Колонки таблицы: ID, TITLE, ARCHIVED (yes у архивного). Итог —
(N spaces); пустой список — (нет пространств).

${COMMON_HELP}

Пример: mpu kiten spaces --all`,
  policy: "ro",
  argsSchema: spacesArgsSchema,
  resultSchema: spacesResultSchema,
  run: runSpaces,
  render: (result, args) =>
    args.json
      ? renderRefsJson(result.spaces)
      : renderSpacesTable(result.spaces),
});

export const kitenBoardsCommand = defineCommand({
  path: ["kiten", "boards"],
  errorName: "kiten boards",
  summary: "Доски всех пространств плоским списком; --space фильтрует.",
  usage: "mpu kiten boards [--space REF] [--json]",
  help: `Доски приходят вложенными в пространства (отдельного списка досок
у API нет) и печатаются плоско, в порядке ответа.

--space REF оставляет доски одного пространства; REF — id либо подстрока
названия без учёта регистра. Фильтр действует только на вывод: в кэш
всегда попадает полный ответ.

Колонки таблицы: ID, SPACE, TITLE. Итог — (N boards); пустой список —
(нет досок).

${COMMON_HELP}

Пример: mpu kiten boards --space Разработка`,
  policy: "ro",
  argsSchema: boardsArgsSchema,
  resultSchema: boardsResultSchema,
  run: runBoards,
  render: (result, args) =>
    args.json
      ? renderRefsJson(result.boards)
      : renderBoardsTable(result.boards),
});

export const kitenLanesCommand = defineCommand({
  path: ["kiten", "lanes"],
  errorName: "kiten lanes",
  summary: "Дорожки досок: одной доски, пространства либо всех сразу.",
  usage: "mpu kiten lanes [--space REF] [--board REF] [--json]",
  help: `Скоуп: --board — одна доска, --space — доски пространства, без
фильтров — все доски компании (запрос на каждую доску скоупа).

${SCOPE_HELP}

Колонки таблицы: ID, BOARD, TITLE. Итог — (N lanes); пустой список —
(нет дорожек).

${COMMON_HELP}

Пример: mpu kiten lanes --board 4001`,
  policy: "ro",
  argsSchema: boardRowsArgsSchema,
  resultSchema: lanesResultSchema,
  run: runLanes,
  render: (result, args) =>
    args.json
      ? renderRefsJson(result.lanes)
      : renderBoardRowsTable(result.lanes, "lanes"),
});

export const kitenColumnsCommand = defineCommand({
  path: ["kiten", "columns"],
  errorName: "kiten columns",
  summary: "Колонки досок: одной доски, пространства либо всех сразу.",
  usage: "mpu kiten columns [--space REF] [--board REF] [--json]",
  help: `Скоуп: --board — одна доска, --space — доски пространства, без
фильтров — все доски компании (запрос на каждую доску скоупа).

${SCOPE_HELP}

Колонки таблицы: ID, BOARD, TITLE. Итог — (N columns); пустой список —
(нет колонок).

${COMMON_HELP}

Пример: mpu kiten columns --space Разработка`,
  policy: "ro",
  argsSchema: boardRowsArgsSchema,
  resultSchema: columnsResultSchema,
  run: runColumns,
  render: (result, args) =>
    args.json
      ? renderRefsJson(result.columns)
      : renderBoardRowsTable(result.columns, "columns"),
});

export const kitenRolesCommand = defineCommand({
  path: ["kiten", "roles"],
  errorName: "kiten roles",
  summary: "Роли компании — типы работ учёта времени.",
  usage: "mpu kiten roles [--all] [--json]",
  help: `Роли — «типы работ» записей времени: их id принимает --role у
mpu kiten time.

Роли с неположительным id (системная Employee) скрыты; --all показывает
их. Фильтр действует только на вывод: в кэш всегда попадает полный
ответ.

Колонки таблицы: ID, NAME. Итог — (N roles); пустой список —
(нет ролей).

${COMMON_HELP}

Пример: mpu kiten roles --json`,
  policy: "ro",
  argsSchema: rolesArgsSchema,
  resultSchema: rolesResultSchema,
  run: runRoles,
  render: (result, args) =>
    args.json ? renderRefsJson(result.roles) : renderRolesTable(result.roles),
});
