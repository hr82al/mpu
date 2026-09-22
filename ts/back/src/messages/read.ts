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

/** Как хвост забирает слова. */
interface Taking {
  take(words: Words): Message;
}

/** Свой хвост: до закрытия. */
const OWN: Taking = { take: (words) => ({ tail: words.takeTail() }) };

/**
 * Чужой хвост: всё до конца как есть — грамматика и справка в нём не
 * толкуются, сообщение помечено чужим.
 */
const FOREIGN: Taking = {
  take: (words) => ({ tail: words.takeAll(), foreign: true }),
};

/**
 * Хвост: слово вне своих унарных селекторов начинает хвост. Закрытие
 * первым словом хвоста не начинает — хвост пуст, закрытие идёт
 * сообщением.
 */
class Tail implements Opening {
  readonly #own: ReadonlySet<string>;
  readonly #taking: Taking;

  constructor(own: readonly string[], taking: Taking) {
    this.#own = new Set(own);
    this.#taking = taking;
  }

  start(words: Words, receiver: Receiver): Message {
    if (!words.opensTail(this.#own, receiver)) {
      return OPEN.start(words, receiver);
    }
    return this.#taking.take(words);
  }
}

function openingOf(description: ReceiverDescription): Opening {
  if (description.tail === undefined) return OPEN;
  const taking = description.foreign === true ? FOREIGN : OWN;
  return new Tail(description.unary, taking);
}

/** Итог шага: сообщение текущему приёмнику и слова, оставшиеся за ним. */
export interface MessageStep {
  readonly message: Message;
  readonly rest: readonly string[];
}

/**
 * Один шаг разбора: первое сообщение из `words` текущему приёмнику.
 * Следующий шаг зовут с остатком и описанием следующего приёмника — его
 * знает только исполнитель, поэтому строка целиком здесь не разбирается.
 *
 * Пустые `words` — справка: `{ unary: "help" }`. У приёмника с хвостом
 * слово вне его унарных селекторов забирает слова хвоста одним
 * сообщением.
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
  return { message, rest: cursor.remaining() };
}
