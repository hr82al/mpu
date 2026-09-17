/**
 * Формы вывода справочных подкоманд `mpu kiten`
 * (`docs/specs/kiten-refs.md`): плоские объекты `--json` с ключами
 * внешней системы и человекочитаемые таблицы с итоговой строкой.
 *
 * Отдельно от команд, потому что у шести подкоманд вывод устроен
 * одинаково — таблица по ширине содержимого плюс итог, — и копия на
 * подкоманду разошлась бы шестью способами. Рендер чист: ни сети, ни
 * диска, ни часов.
 */

import { z } from "@zod/zod";

/**
 * Владелец токена в форме вывода: ключи снейк-кейсом ответа, а не
 * идиомой TS, — этот же объект печатается на `--json`.
 */
export const userViewSchema = z.object({
  id: z.number().int().describe("id пользователя"),
  full_name: z.string().describe("отображаемое имя; его нет — пустая строка"),
  username: z.string().describe("логин; его нет — пустая строка"),
  email: z.string().describe("почта; её нет — пустая строка"),
});

/** Пространство в форме вывода. */
export const spaceViewSchema = z.object({
  id: z.number().int().describe("id пространства"),
  title: z.string().describe("название пространства"),
  archived: z.boolean().describe("пространство в архиве"),
});

/** Доска в форме вывода: пространство — числом, названия у него тут нет. */
export const boardViewSchema = z.object({
  id: z.number().int().describe("id доски"),
  space_id: z.number().int().describe("id пространства доски"),
  title: z.string().describe("название доски"),
});

/** Дорожка либо колонка: у обеих один набор полей. */
export const boardRowViewSchema = z.object({
  id: z.number().int().describe("id дорожки либо колонки"),
  board_id: z.number().int().describe("id доски"),
  title: z.string().describe("название дорожки либо колонки"),
});

/** Роль компании («тип работ» учёта времени) в форме вывода. */
export const roleViewSchema = z.object({
  id: z.number().int().describe("id роли"),
  name: z.string().describe("название роли"),
});

/** Владелец токена глазами вывода. */
export type UserView = z.infer<typeof userViewSchema>;
/** Пространство глазами вывода. */
export type SpaceView = z.infer<typeof spaceViewSchema>;
/** Доска глазами вывода. */
export type BoardView = z.infer<typeof boardViewSchema>;
/** Дорожка либо колонка глазами вывода. */
export type BoardRowView = z.infer<typeof boardRowViewSchema>;
/** Роль компании глазами вывода. */
export type RoleView = z.infer<typeof roleViewSchema>;

/** Вид справочника: от него зависят только слова итога и пустоты. */
export type RefTableKind = "spaces" | "boards" | "lanes" | "columns" | "roles";

/** Строка пустой выдачи по виду справочника. */
const EMPTY_LINE: Readonly<Record<RefTableKind, string>> = {
  spaces: "(нет пространств)",
  boards: "(нет досок)",
  lanes: "(нет дорожек)",
  columns: "(нет колонок)",
  roles: "(нет ролей)",
};

/** Колонки таблицы по виду справочника, в порядке печати. */
const COLUMNS: Readonly<Record<RefTableKind, readonly string[]>> = {
  spaces: ["ID", "TITLE", "ARCHIVED"],
  boards: ["ID", "SPACE", "TITLE"],
  lanes: ["ID", "BOARD", "TITLE"],
  columns: ["ID", "BOARD", "TITLE"],
  roles: ["ID", "NAME"],
};

/** Любой из шести выводов `--json`: отступ 2, юникод как есть, один `\n`. */
export function renderRefsJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Владелец токена человеку — ровно четыре строки с выровненными
 * подписями (`kiten-refs.md`, «Ввод/вывод»).
 */
export function renderWhoami(user: UserView): string {
  return [
    `id:    ${user.id}`,
    `name:  ${user.full_name}`,
    `login: ${user.username}`,
    `email: ${user.email}`,
  ].join("\n") + "\n";
}

/** Пространства таблицей; архивное помечено `yes`, остальные — пусто. */
export function renderSpacesTable(spaces: readonly SpaceView[]): string {
  return renderRefTable(
    "spaces",
    spaces.map((space) => [
      String(space.id),
      space.title,
      space.archived ? "yes" : "",
    ]),
  );
}

/** Доски таблицей: пространство — числом, как и в `--json`. */
export function renderBoardsTable(boards: readonly BoardView[]): string {
  return renderRefTable(
    "boards",
    boards.map((board) => [
      String(board.id),
      String(board.space_id),
      board.title,
    ]),
  );
}

/** Дорожки либо колонки таблицей: вид различает только слова итога. */
export function renderBoardRowsTable(
  rows: readonly BoardRowView[],
  kind: "lanes" | "columns",
): string {
  return renderRefTable(
    kind,
    rows.map((row) => [String(row.id), String(row.board_id), row.title]),
  );
}

/** Роли компании таблицей. */
export function renderRolesTable(roles: readonly RoleView[]): string {
  return renderRefTable(
    "roles",
    roles.map((role) => [String(role.id), role.name]),
  );
}

/**
 * Таблица с шапкой и итогом `({N} <вид>)`; пустой список печатается
 * одной строкой «нет …» без шапки. Ширина колонок подгоняется под
 * содержимое и контрактом не является (`kiten-refs.md`,
 * «Golden-примеры»): сверяются состав колонок, порядок строк и итог.
 */
function renderRefTable(
  kind: RefTableKind,
  cells: readonly (readonly string[])[],
): string {
  if (cells.length === 0) return `${EMPTY_LINE[kind]}\n`;
  const rows = [COLUMNS[kind], ...cells];
  const widths = columnWidths(rows);
  const table = rows
    .map((row) =>
      row.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd()
    )
    .join("\n");
  return `${table}\n(${cells.length} ${kind})\n`;
}

/** Ширина каждой колонки: длиннейшая ячейка столбца в символах. */
function columnWidths(
  rows: readonly (readonly string[])[],
): readonly number[] {
  const widths = new Array<number>(rows[0].length).fill(0);
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index], [...cell].length);
    });
  }
  return widths;
}
