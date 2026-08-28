/**
 * Формы вывода `mpu glab-status` (`docs/specs/glab-status.md`):
 * таблица, шапки MR и подвал «прочие ветки».
 *
 * Рамки и выравнивание спека не фиксирует — сверяются состав и порядок
 * колонок, — поэтому таблица рисуется тем же способом, что у `mpu ps`
 * и `mpu mr files`: колонки по содержимому, разделитель — два пробела.
 * Одна форма таблицы на весь CLI лучше, чем своя в каждой команде.
 *
 * Ширину терминала определяет `run` и кладёт в результат — тем же
 * приёмом, что `mpu kiten card` кладёт туда вид вывода: у контракта
 * `render` доступа к среде нет, а усечение заголовка спека требует.
 *
 * Ширина считается в терминальных ячейках, а не в символах: галочка
 * `✅` занимает две, и счёт по длине строки сдвигал бы каждую колонку
 * правее себя — именно ту, ради которой таблицу и смотрят.
 */

import { PIPELINE_BRANCHES, type StatusRow } from "./rows.ts";

/** Разделитель колонок; тот же, что у прочих таблиц CLI. */
const GAP = "  ";

/** Ширина символа в терминальных ячейках: emoji и CJK — две. */
function charWidth(code: number): number {
  if (code >= 0x1100 && code <= 0x115f) return 2;
  if (code >= 0x2e80 && code <= 0xa4cf) return 2;
  if (code >= 0xac00 && code <= 0xd7a3) return 2;
  if (code >= 0xf900 && code <= 0xfaff) return 2;
  if (code >= 0xfe30 && code <= 0xfe6f) return 2;
  if (code >= 0xff00 && code <= 0xff60) return 2;
  if (code >= 0x2705 && code <= 0x27bf) return 2;
  if (code >= 0x1f300 && code <= 0x1faff) return 2;
  return 1;
}

/** Ширина строки в терминальных ячейках. */
export function textWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charWidth(char.codePointAt(0) ?? 0);
  return width;
}

/**
 * Усечение до ширины с хвостом `…`. Места нет вовсе — пустая строка, а
 * не одно многоточие: оно само занимает ячейку и сдвинуло бы колонки.
 */
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (textWidth(text) <= width) return text;
  let result = "";
  let used = 0;
  for (const char of text) {
    const size = charWidth(char.codePointAt(0) ?? 0);
    if (used + size > width - 1) break;
    result += char;
    used += size;
  }
  return `${result}…`;
}

/** Таблица с выравниванием по терминальным ячейкам. */
function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = header.map((title, column) =>
    Math.max(textWidth(title), ...rows.map((row) => textWidth(row[column])))
  );
  return [header, ...rows]
    .map((row) =>
      row
        .map((cell, column) =>
          cell + " ".repeat(Math.max(widths[column] - textWidth(cell), 0))
        )
        .join(GAP)
        .trimEnd()
    )
    .map((line) => `${line}\n`)
    .join("");
}

/** Заголовки таблицы: три своих плюс по колонке на ветку. */
export const TABLE_HEADER: readonly string[] = [
  "repo",
  "id",
  "title",
  ...PIPELINE_BRANCHES,
];

/** Ячейки строки; галочка ⇔ ветка содержит landing-коммит. */
function cellsOf(row: StatusRow, titleWidth: number): readonly string[] {
  return [
    row.repo,
    String(row.iid),
    truncate(row.title, titleWidth),
    ...PIPELINE_BRANCHES.map((branch) =>
      row.landed.includes(branch) ? "✅" : ""
    ),
  ];
}

/**
 * Сколько ширины остаётся заголовку. Колонки веток не скрываются
 * никогда: без них таблица теряет смысл, а без длинного заголовка —
 * нет.
 */
function titleBudget(
  rows: readonly StatusRow[],
  columns: number | null,
): number {
  if (columns === null) return Number.POSITIVE_INFINITY;
  const fixed = [
    Math.max(textWidth("repo"), ...rows.map((row) => textWidth(row.repo))),
    Math.max(textWidth("id"), ...rows.map((row) => String(row.iid).length)),
    ...PIPELINE_BRANCHES.map((branch) => Math.max(textWidth(branch), 2)),
  ];
  const used = fixed.reduce((sum, width) => sum + width, 0) +
    GAP.length * fixed.length;
  return Math.max(columns - used, 0);
}

/** Таблица со всеми шестью колонками веток; они не скрываются. */
export function renderRows(
  rows: readonly StatusRow[],
  columns: number | null,
): string {
  const width = titleBudget(rows, columns);
  return table(TABLE_HEADER, rows.map((row) => [...cellsOf(row, width)]));
}

/** Шапка MR: адрес, состояние и ветки. */
export function headline(row: StatusRow): string {
  const project = row.project ?? "?";
  const state = row.state === "" ? "?" : row.state;
  // У MR без коммитов обе ветки пусты, и сегмент опускается целиком:
  // «· →» без имён не сказал бы ничего.
  const branches = row.source_branch === "" && row.target_branch === ""
    ? ""
    : ` · ${row.source_branch} → ${row.target_branch}`;
  return `${project}!${row.iid} · ${state}${branches}`;
}

/**
 * Ячейка подвала. «Нет данных» и «нет» — разные вещи: первое означает,
 * что о ветках неизвестно, второе — что их действительно нет.
 */
export function otherCell(row: StatusRow, full: boolean): string {
  if (row.other_branches === null) {
    return row.state === "merged" ? "(нет данных)" : "(MR не смержен)";
  }
  if (row.other_branches.length === 0) return "(нет)";
  return full
    ? row.other_branches.join(", ")
    : `${row.other_branches.length} (показать: --branches)`;
}

/** Подвал: одна строка на один MR, список — на несколько. */
export function renderFooter(
  rows: readonly StatusRow[],
  full: boolean,
): string {
  if (rows.length === 1) {
    return `прочие ветки: ${otherCell(rows[0], full)}\n`;
  }
  const lines = rows.map((row) =>
    `  ${row.project ?? "?"}!${row.iid}: ${otherCell(row, full)}\n`
  );
  return `прочие ветки:\n${lines.join("")}`;
}
