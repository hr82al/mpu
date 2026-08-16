/**
 * Данные вывода чек-листов карточки и их оформление
 * (`docs/specs/kiten-checklist.md`): порядок пунктов, таблица и JSON
 * `ls`, перечень кандидатов в сообщениях о ссылке на пункт.
 *
 * Порядок здесь — не украшение: `items[]` сервер отдаёт в произвольном
 * порядке, и один и тот же порядок обязан быть и в таблице, и в перечне
 * кандидатов — человек сверяет второе с первым. Поэтому сортировка живёт
 * рядом с обоими её потребителями, а не у каждого своя.
 *
 * Рендер чист: ни сети, ни диска, ни часов.
 */

import { z } from "@zod/zod";
import type { Checklist, ChecklistItem } from "../kaiten/mod.ts";

/** Пункт чек-листа в форме вывода: ключи и их порядок — контракт `--json`. */
export const checklistItemViewSchema = z.object({
  id: z.number().int().describe("id пункта: им же адресуется check/uncheck"),
  checked: z.boolean().describe("отмечен ли пункт"),
  text: z.string().describe("текст пункта"),
});

/** Чек-лист в форме вывода: имя и пункты в порядке показа. */
export const checklistViewSchema = z.object({
  id: z.number().int().describe("id чек-листа"),
  name: z.string().describe("название чек-листа"),
  items: z.array(checklistItemViewSchema).describe(
    "пункты по возрастанию sort_order, при равенстве по id",
  ),
});

/** Чек-лист глазами вывода. */
export type ChecklistView = z.infer<typeof checklistViewSchema>;

/** Пункт карточки вместе с чек-листом, в котором он лежит. */
export interface CardChecklistItem {
  readonly checklistId: number;
  readonly item: ChecklistItem;
}

/** Предел текста пункта в перечне кандидатов (`kiten-checklist.md`). */
const CANDIDATE_TEXT_LIMIT = 60;

/** Шапка таблицы `ls`; ячейки — контракт голдена, не оформление. */
const COLUMNS = ["id", "✓", "text"] as const;

/**
 * Чек-листы карточки в форме вывода: пункты уже упорядочены. Массив
 * собирается на каждый вызов заново — он и уходит в результат команды.
 */
export function checklistViews(
  checklists: readonly Checklist[],
): ChecklistView[] {
  return checklists.map((checklist) => ({
    id: checklist.id,
    name: checklist.name,
    items: sortedItems(checklist.items).map((item) => ({
      id: item.id,
      checked: item.checked,
      text: item.text,
    })),
  }));
}

/**
 * Все пункты карточки одним списком в том же порядке, что и в таблице:
 * поиск пункта сквозной по карточке, поэтому чек-лист остаётся при
 * пункте — в него уйдёт отметка.
 */
export function cardItems(
  checklists: readonly Checklist[],
): readonly CardChecklistItem[] {
  const items = checklists.flatMap((checklist) =>
    checklist.items.map((item) => ({ checklistId: checklist.id, item }))
  );
  return items.sort((left, right) => compareItems(left.item, right.item));
}

/**
 * Таблица `ls`: блок на чек-лист, блоки разделены пустой строкой. Текст
 * пункта печатается одной строкой целиком и по ширине терминала не
 * переносится: именно его копируют в `check <подстрока>`
 * (`kiten-checklist.md`, «Известные отклонения»).
 */
export function renderChecklists(views: readonly ChecklistView[]): string {
  if (views.length === 0) return "(чек-листов нет)\n";
  return views.map(checklistBlock).join("\n");
}

/** JSON-вывод `ls`: отступ 2, ровно один перевод строки в конце. */
export function renderChecklistsJson(views: readonly ChecklistView[]): string {
  return `${JSON.stringify(views, null, 2)}\n`;
}

/**
 * Перечень кандидатов для сообщений о неоднозначной и ненайденной
 * ссылке: `{id}: {текст}` через `; ` в порядке таблицы, текст обрезан.
 */
export function candidateList(items: readonly CardChecklistItem[]): string {
  return items
    .map(({ item }) => `${item.id}: ${trimText(item.text)}`)
    .join("; ");
}

/** Пункты чек-листа в порядке показа; вход не меняется. */
function sortedItems(
  items: readonly ChecklistItem[],
): readonly ChecklistItem[] {
  return [...items].sort(compareItems);
}

/** Порядок пунктов: `sort_order`, при равенстве — `id`. */
function compareItems(left: ChecklistItem, right: ChecklistItem): number {
  const byOrder = weight(left) - weight(right);
  return byOrder === 0 ? left.id - right.id : byOrder;
}

/** Вес сортировки; пункт без `sort_order` весит ноль, как и его отсутствие. */
function weight(item: ChecklistItem): number {
  return item.sortOrder ?? 0;
}

/** Блок одного чек-листа: заголовок со счётчиком и таблица пунктов. */
function checklistBlock(view: ChecklistView): string {
  const checked = view.items.filter((item) => item.checked).length;
  const header =
    `${view.name} · ${checked}/${view.items.length} (checklist id ${view.id})`;
  const rows = [
    [...COLUMNS],
    ...view.items.map((item) => [
      String(item.id),
      item.checked ? "[x]" : "[ ]",
      item.text,
    ]),
  ];
  return `${header}\n${table(rows)}\n`;
}

/** Строки таблицы: колонки по ширине содержимого, ряд в рамке из пробелов. */
function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0].map((_, index) =>
    Math.max(...rows.map((row) => row[index].length))
  );
  return rows
    .map((row) =>
      ` ${row.map((cell, index) => cell.padEnd(widths[index])).join("  ")} `
    )
    .join("\n");
}

/** Текст кандидата: длинный обрезается, чтобы перечень читался. */
function trimText(text: string): string {
  return text.length <= CANDIDATE_TEXT_LIMIT
    ? text
    : text.slice(0, CANDIDATE_TEXT_LIMIT);
}
