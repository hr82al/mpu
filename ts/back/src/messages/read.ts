import type { Message } from "./message.ts";
import { Receiver, type ReceiverDescription } from "./receiver.ts";
import { Words } from "./words.ts";

/** Итог шага: сообщение текущему приёмнику и слова, оставшиеся за ним. */
export interface MessageStep {
  readonly message: Message;
  readonly rest: readonly string[];
}

/**
 * Один шаг разбора: первое сообщение из `words` текущему приёмнику.
 * Точка, закрывшая сообщение, забирается этим же шагом. Следующий шаг
 * зовут с остатком и описанием следующего приёмника — его знает только
 * исполнитель, поэтому строка целиком здесь не разбирается.
 *
 * Пустые `words` — справка: `{ unary: "help" }`.
 *
 * @param words оставшиеся слова строки, как их отдала оболочка
 * @param receiver описание текущего приёмника
 * @throws MessageParseError слова не складываются в сообщение или
 *   описание приёмника противоречиво
 */
export function readMessage(
  words: readonly string[],
  receiver: ReceiverDescription,
): MessageStep {
  const target = new Receiver(receiver);
  const cursor = new Words(words);
  const message = cursor.next().start(cursor, target);
  cursor.peek().close(cursor);
  return { message, rest: cursor.rest() };
}
