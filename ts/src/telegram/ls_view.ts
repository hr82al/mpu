/**
 * Вывод `mpu telegram ls` (`docs/specs/telegram-ls.md`, «Ввод/вывод»):
 * JSON по умолчанию и таблица по флагу.
 */

import type { Dialog } from "./chat.ts";
import { alignedRows } from "./table.ts";

/** JSON-массив: отступ 2, юникод как есть, один перевод строки в конце. */
export function renderDialogsJson(dialogs: readonly Dialog[]): string {
  return `${JSON.stringify(dialogs, null, 2)}\n`;
}

/**
 * Таблица тех же данных. Ширины колонок считаются по содержимому и
 * контрактом не являются — контракт это состав и порядок колонок,
 * порядок строк и итоговая строка (там же).
 */
export function renderDialogsTable(dialogs: readonly Dialog[]): string {
  if (dialogs.length === 0) return "(нет диалогов)\n";
  const rows = [
    ["ID", "KIND", "USERNAME", "TITLE"],
    ...dialogs.map((dialog) => [
      String(dialog.id),
      dialog.kind,
      // Отсутствие имени — пустая клетка, а не слово «null»: таблицу
      // читает человек, а `null` из JSON он прочтёт как значение.
      dialog.username ?? "",
      dialog.title,
    ]),
  ];
  const table = alignedRows(rows);
  // Итог по-английски при русском «(нет диалогов)» рядом: строка уже
  // разошлась по чужим скриптам как признак конца вывода (там же,
  // «Известные отклонения», вердикт preserve).
  return `${table}\n(${dialogs.length} dialogs)\n`;
}
