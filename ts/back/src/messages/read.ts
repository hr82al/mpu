import type { Message } from "./message.ts";
import { Receiver, type ReceiverDescription } from "./receiver.ts";
import { Words } from "./words.ts";

/** Как приёмник начинает шаг. */
interface Opening {
  start(words: Words, receiver: Receiver): Message;
}

/** Хвоста нет: шаг начинается с очередного слова. */
const OPEN: Opening = {
  start: (words, receiver) => words.next().start(words, receiver),
};

/** Хвост: слово вне своих унарных селекторов забирает всё оставшееся. */
class Tail implements Opening {
  readonly #own: ReadonlySet<string>;

  constructor(own: readonly string[]) {
    this.#own = new Set(own);
  }

  start(words: Words, receiver: Receiver): Message {
    if (!words.firstOutside(this.#own)) return OPEN.start(words, receiver);
    return { tail: words.takeAll() };
  }
}

function openingOf(description: ReceiverDescription): Opening {
  if (description.tail === undefined) return OPEN;
  return new Tail(description.unary);
}

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
 * Пустые `words` — справка: `{ unary: "help" }`. У приёмника с хвостом
 * слово вне его унарных селекторов забирает все слова одним сообщением.
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
  const message = openingOf(receiver).start(cursor, target);
  cursor.peek().close(cursor);
  return { message, rest: cursor.rest() };
}
