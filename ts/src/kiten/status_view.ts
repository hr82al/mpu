/**
 * Формы вывода `mpu kiten status` (`docs/specs/kiten-status.md`,
 * «Формы вывода»): json, md, url, шаблон и две человекочитаемые —
 * матрица и секции по этапам.
 *
 * Машинные формы подвала и рамок не печатают (инвариант спеки): их
 * читают программы, и лишняя строка там — не «оформление», а мусор в
 * данных.
 */

import { PIPELINE, type Stage } from "./stage.ts";
import type { StatusRow } from "./status_data.ts";

/** Строка выдачи в форме `--out json`: пятнадцать ключей по порядку. */
export function jsonRows(rows: readonly StatusRow[]): readonly unknown[] {
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    url: row.url,
    stage: row.stage,
    column: row.column,
    board: row.board,
    space: row.space,
    lane: row.lane,
    state: row.state,
    closed: row.closed,
    escalated: row.escalated,
    due_date: row.dueDate,
    updated: row.updated,
    my_minutes: row.myMinutes,
    sources: row.sources,
  }));
}

/** `--out md`: GFM-таблица; экранирование ячеек — как в `kiten-ls.md`. */
export function renderMd(rows: readonly StatusRow[], today: number): string {
  const head = "| ID | ЭТАП | ВРЕМЯ | ОБНОВЛ | ДОРОЖКА | TITLE |\n" +
    "| --- | --- | --- | --- | --- | --- |\n";
  return head + rows.map((row) =>
    "| " + [
      String(row.id),
      row.stage,
      minutesText(row.myMinutes),
      updatedText(row.updated, today),
      placeText(row),
      cell(row.title),
    ].join(" | ") + " |\n"
  ).join("");
}

/** `--out url`: ссылка markdown по строке; скобки в заголовке экранируются. */
export function renderUrls(rows: readonly StatusRow[]): string {
  return rows.map((row) =>
    `[${row.title.replaceAll("[", "\\[").replaceAll("]", "\\]")}](${row.url})\n`
  ).join("");
}

/**
 * `--format TPL`: текстовая замена плейсхолдеров, как в `kiten-ls.md`.
 * Неизвестный плейсхолдер остаётся как есть, а данные не
 * интерпретируются — фигурная скобка внутри заголовка остаётся буквой.
 */
export function renderFormat(
  rows: readonly StatusRow[],
  template: string,
): string {
  return rows.map((row, index) => {
    const values: Readonly<Record<string, string>> = {
      "{n}": String(index + 1),
      "{id}": String(row.id),
      "{title}": row.title,
      "{url}": row.url,
      "{stage}": row.stage,
      "{board}": row.board ?? "",
      "{lane}": row.lane ?? "",
      "{due}": dueText(row.dueDate),
      "{min}": String(row.myMinutes),
      // Через запятую: оригинал склеивал имена без разделителя
      // (отклонение `fix`).
      "{src}": [...row.sources].sort().join(","),
    };
    let line = template;
    for (const [placeholder, value] of Object.entries(values)) {
      line = line.replaceAll(placeholder, value);
    }
    return `${line}\n`;
  }).join("");
}

/** Итоговая строка подвала человекочитаемых форм. */
export function footer(
  rows: readonly StatusRow[],
  minutesByRole: Readonly<Record<string, number>>,
): string {
  const open = rows.filter((row) => !row.closed).length;
  const touch =
    rows.filter((row) =>
      row.sources.length === 1 && row.sources[0] === "activity"
    ).length;
  const total = Object.values(minutesByRole).reduce(
    (sum, minutes) => sum + minutes,
    0,
  );
  const roles = Object.entries(minutesByRole)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([role, minutes]) => `${role} ${minutesText(minutes)}`)
    .join(", ");
  const parts = [
    `${rows.length} карточек (${open} в работе, ${rows.length - open} закрыто)`,
    `время за окно: ${minutesText(total)}${roles === "" ? "" : ` (${roles})`}`,
    `только из ленты: ${touch}`,
  ];
  return `${parts.join(" · ")}\n`;
}

/** Этапы, по которым есть строки, в порядке конвейера. */
export function stagesOf(rows: readonly StatusRow[]): readonly Stage[] {
  const present = new Set(rows.map((row) => row.stage));
  const known = PIPELINE.filter((stage) => present.has(stage));
  return present.has("—") ? [...known, "—"] : known;
}

/** Маркеры источников строки: назначена, списывал время, трогал. */
export function sourceMarks(row: StatusRow): string {
  const marks: string[] = [];
  if (row.sources.includes("assigned")) marks.push("👤");
  if (row.sources.includes("time")) marks.push("🕒");
  if (row.sources.includes("activity")) marks.push("📝");
  return marks.join("");
}

/** Место строки: дорожка, иначе пространство, иначе доска (спека). */
export function placeText(row: StatusRow): string {
  return cell(row.lane ?? row.space ?? row.board ?? "");
}

/** Время строки: `{часы}ч{минуты:02}м`, без часов — `{минуты}м`, 0 — `—`. */
export function minutesText(minutes: number): string {
  if (minutes <= 0) return "—";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0
    ? `${rest}м`
    : `${hours}ч${String(rest).padStart(2, "0")}м`;
}

/** Дата обновления: `сегодня` / `вчера` / `MM.DD`; неизвестна — `—`. */
export function updatedText(updated: string | null, today: number): string {
  const parsed = updated === null ? NaN : Date.parse(updated);
  if (!Number.isFinite(parsed)) return "—";
  const day = Math.floor(parsed / 1000 / 86_400);
  const todayDay = Math.floor(today / 86_400);
  if (day === todayDay) return "сегодня";
  if (day === todayDay - 1) return "вчера";
  const date = new Date(parsed);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${month}.${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** Срок в форме `YYYY-MM-DD`; не задан — пусто. */
export function dueText(dueDate: string | null): string {
  return dueDate === null ? "" : dueDate.slice(0, 10);
}

/** Ячейка таблицы markdown: `|` экранируется, переводы строк — пробел. */
function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll(/\s*\n\s*/g, " ");
}
