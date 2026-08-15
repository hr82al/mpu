/**
 * Данные вывода записей времени и их оформление
 * (`docs/specs/kiten-time.md`, «CLI-контракт»): длительность и счётчик
 * словами, запись в форме JSON-вывода, таблица `ls`.
 *
 * Отдельно от команд — потому что подкоманды таймера печатают ту же
 * запись теми же словами: `stop` перечитывает созданную запись и
 * показывает её длительность, `status` — итог по карточке.
 *
 * Рендер чист: ни сети, ни диска, ни часов.
 */

import { z } from "@zod/zod";
import type { TimeLog } from "../kaiten/mod.ts";

/**
 * Запись времени в форме вывода: плоский объект с ключами внешней
 * системы. Он же — JSON-вывод `ls` (`kiten-time.md`, `--json`), поэтому
 * имена полей — снейк-кейс ответа, а не идиома TS.
 */
export const timeLogViewSchema = z.object({
  id: z.number().int().describe("id записи"),
  card_id: z.number().int().describe("id карточки записи"),
  for_date: z.string().describe("день записи YYYY-MM-DD"),
  minutes: z.number().int().describe("длительность в целых минутах"),
  role_id: z.number().int().nullable().describe("id роли записи"),
  role: z.string().nullable().describe(
    "название роли из ответа внешней системы; названия нет — null",
  ),
  user_id: z.number().int().nullable().describe("id владельца записи"),
  user: z.string().nullable().describe("отображаемое имя владельца записи"),
  comment: z.string().describe("комментарий записи; пустая строка — его нет"),
});

/** Запись времени глазами вывода. */
export type TimeLogView = z.infer<typeof timeLogViewSchema>;

/** Колонки таблицы `ls` в порядке печати; `ПОЛЬЗОВАТЕЛЬ` — только при `--all`. */
const COLUMNS = ["ID", "ДАТА", "ВРЕМЯ", "РОЛЬ", "КОММЕНТАРИЙ"] as const;

/** Запись каталога в форму вывода: команда наружу отдаёт именно её. */
export function timeLogView(log: TimeLog): TimeLogView {
  return {
    id: log.id,
    card_id: log.cardId,
    for_date: log.forDate,
    minutes: log.timeSpent,
    role_id: log.roleId,
    // Пустое название — то же «названия нет», что и его отсутствие:
    // спека знает у поля два состояния, название и `null`.
    role: log.roleName === "" ? null : log.roleName,
    user_id: log.userId,
    user: log.userName,
    comment: log.comment,
  };
}

/** Длительность словами: `1 ч 15 мин`, `2 ч`, `45 мин`. */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} мин`;
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}

/** Счётчик записей: «1 запись», «2 записи», «5 записей». */
export function formatLogCount(count: number): string {
  return `${count} ${logWord(count)}`;
}

/**
 * Роль в таблице и в `ok:`-строках: колонка заполнена всегда, поэтому без
 * названия печатается числовой id. Асимметрия с JSON, где `role` при
 * отсутствии названия равен `null`, — требование спеки, а не недосмотр.
 */
export function roleLabel(log: TimeLogView): string {
  if (log.role !== null) return log.role;
  return log.role_id === null ? "" : String(log.role_id);
}

/**
 * Таблица `ls` с итоговой строкой; пустой список — `(пусто)`. Ширина
 * колонок подгоняется под содержимое и контрактом не является
 * (`kiten-time.md`, «Golden-примеры»): сверяются состав колонок, порядок
 * строк и итог.
 */
export function renderTimeLogTable(
  logs: readonly TimeLogView[],
  totalMinutes: number,
  options: { readonly withUser: boolean },
): string {
  if (logs.length === 0) return "(пусто)\n";
  const rows = [
    headerRow(options.withUser),
    ...logs.map((log) => bodyRow(log, options.withUser)),
  ];
  const widths = columnWidths(rows);
  const table = rows
    .map((row) =>
      row.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd()
    )
    .join("\n");
  const total = `итого: ${formatDuration(totalMinutes)} (${
    formatLogCount(logs.length)
  })`;
  return `${table}\n${total}\n`;
}

/** JSON-вывод `ls`: отступ 2, ровно один перевод строки в конце. */
export function renderTimeLogJson(
  logs: readonly TimeLogView[],
  totalMinutes: number,
): string {
  return `${JSON.stringify({ total_minutes: totalMinutes, logs }, null, 2)}\n`;
}

function headerRow(withUser: boolean): readonly string[] {
  const [id, date, time, role, comment] = COLUMNS;
  return withUser
    ? [id, date, time, role, "ПОЛЬЗОВАТЕЛЬ", comment]
    : [id, date, time, role, comment];
}

function bodyRow(log: TimeLogView, withUser: boolean): readonly string[] {
  const head = [
    String(log.id),
    log.for_date,
    formatDuration(log.minutes),
    roleLabel(log),
  ];
  const user = log.user === null ? "" : log.user;
  return withUser ? [...head, user, log.comment] : [...head, log.comment];
}

function columnWidths(rows: readonly (readonly string[])[]): readonly number[] {
  return rows[0].map((_, index) =>
    Math.max(...rows.map((row) => row[index].length))
  );
}

/** Русское склонение слова «запись» по числу. */
function logWord(count: number): string {
  const tail = count % 100;
  if (tail >= 11 && tail <= 14) return "записей";
  const last = count % 10;
  if (last === 1) return "запись";
  return last >= 2 && last <= 4 ? "записи" : "записей";
}
