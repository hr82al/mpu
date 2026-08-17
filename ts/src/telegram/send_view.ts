/**
 * Вывод отправки (`docs/specs/telegram-send.md`, «Ввод/вывод»): одна
 * строка JSON. Ту же строку печатает дневной отчёт после отправки
 * (`docs/specs/telegram-status.md`), поэтому форма живёт в одном месте.
 */

/** Отправленное сообщение в форме вывода: ключи и порядок — контракт. */
export interface SentView {
  readonly id: number;
  readonly chat_id: number;
  readonly date: string | null;
}

/**
 * Строка собирается вручную, а не `JSON.stringify`: контракт вывода —
 * пробел после «:» и «,», юникод без экранирования, порядок ключей.
 */
export function renderSent(sent: SentView): string {
  return `{"id": ${sent.id}, "chat_id": ${sent.chat_id}, "date": ${
    sent.date === null ? "null" : `"${sent.date}"`
  }}\n`;
}
