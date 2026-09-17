/**
 * Вывод `mpu telegram search` (`docs/specs/telegram-search.md`,
 * «Ввод/вывод»): JSON по умолчанию и таблица по флагу.
 */

import type { FoundMessage } from "./message.ts";
import { alignedRows } from "./table.ts";

/** JSON-массив: отступ 2, юникод как есть, один перевод строки в конце. */
export function renderMessagesJson(messages: readonly FoundMessage[]): string {
  return `${JSON.stringify(messages, null, 2)}\n`;
}

/**
 * Таблица тех же данных. Контракт — состав и порядок колонок, порядок
 * строк и итоговая строка; ширины считаются по содержимому и контрактом
 * не являются (там же).
 */
export function renderMessagesTable(messages: readonly FoundMessage[]): string {
  if (messages.length === 0) return "(ничего не найдено)\n";
  const rows = [
    ["DATE", "CHAT", "SENDER", "TEXT"],
    ...messages.map((message) => [
      // Отсутствие значения — пустая клетка, а не слово «null»: таблицу
      // читает человек, а `null` из JSON он прочтёт как значение.
      message.date ?? "",
      message.chat_title,
      message.sender ?? "",
      message.text,
    ]),
  ];
  // Итог по-английски при русском «(ничего не найдено)» рядом: та же
  // пара, что у `ls`, и та же причина — строка разошлась по чужим
  // скриптам как признак конца вывода (там же, «Известные отклонения»,
  // вердикт preserve).
  return `${alignedRows(rows)}\n(${messages.length} messages)\n`;
}
