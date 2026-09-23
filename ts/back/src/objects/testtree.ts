/**
 * Тестовое дерево спеки (`docs/specs/platform/objects.md`, «Тестовое
 * дерево»): классы состояния и их виды. Методы объявлены не по алфавиту
 * намеренно — сортировку в `selectors` и справке должно быть видно.
 */

import {
  type Call,
  DATA,
  type Doc,
  keyword,
  link,
  origin,
  type Outcome,
  Refusal,
  Shape,
  unary,
} from "./mod.ts";

/**
 * Итог для сравнения в тестах: отказ — его текстом (`error`). Объект
 * отказа держит поля приватно, и `assertEquals` сравнил бы два разных
 * отказа как равные.
 */
export function said(outcome: Outcome): unknown {
  if (!("refused" in outcome)) return outcome;
  return { error: outcome.refused.text(), code: outcome.code };
}

function about(purpose: string): Doc {
  return { purpose, help: `Справка: ${purpose}.` };
}

class Comment {
  readonly #card: string;

  constructor(card: string) {
    this.#card = card;
  }

  write(text: string) {
    return { commented: this.#card, text };
  }
}

const COMMENT = new Shape<Comment>(
  [unary("clear", about("убрать текст"), DATA, (c) => c.write(""))],
  {
    fallback: link(
      "<text>",
      about("текст комментария"),
      DATA,
      (c, word) => c.write(word),
    ),
  },
);

class Card {
  readonly #id: string;

  constructor(id: string) {
    this.#id = id;
  }

  show() {
    return { id: this.#id };
  }

  comment(): Comment {
    return new Comment(this.#id);
  }
}

const CARD = new Shape<Card>([
  unary("show", about("карточка целиком"), DATA, (c) => c.show()),
  keyword(
    { comment: "value" },
    ["comment"],
    about("оставить комментарий"),
    DATA,
    (c, args) => c.comment().write(String(args.comment)),
  ),
  unary(
    "comment",
    about("комментарий к карточке"),
    COMMENT,
    (c) => c.comment(),
  ),
]);

class Cards {
  numbered(word: string): Card {
    if (!/^[0-9]+$/.test(word)) throw new Refusal(`нет карточки ${word}`);
    return new Card(word);
  }
}

const CARDS = new Shape<Cards>(
  [],
  {
    fallback: link(
      "<card>",
      about("карточка с номером"),
      CARD,
      (c, word) => c.numbered(word),
    ),
  },
);

/** Kaiten тестового дерева; считает вызовы `ls`. */
export class Kaiten {
  #listed = 0;

  ls(): string[] {
    this.#listed++;
    return ["a", "b"];
  }

  /** Сколько раз исполнялся `ls`. */
  listed(): number {
    return this.#listed;
  }
}

const KITEN = new Shape<Kaiten>([
  unary("ls", about("мои карточки"), DATA, (k) => k.ls()),
  keyword(
    { card: "value" },
    ["card"],
    about("одна карточка по номеру"),
    CARD,
    (_k, args) => new Card(String(args.card)),
  ),
  unary("card", about("карточки по номеру"), CARDS, () => new Cards()),
]);

class Root {
  readonly #kiten: Kaiten;

  constructor(kiten: Kaiten) {
    this.#kiten = kiten;
  }

  kiten(): Kaiten {
    return this.#kiten;
  }
}

const ROOT = new Shape<Root>([
  unary("version", about("версия mpu"), DATA, () => "0.1.0"),
  unary("kiten", about("карточки Kaiten"), KITEN, (r) => r.kiten()),
]);

/** Корень дерева и объект Kaiten внутри него. */
export function testTree(): { readonly root: Call; readonly kiten: Kaiten } {
  const kiten = new Kaiten();
  const root = origin(
    about("вспомогательные операции над данными монорепо"),
    ROOT,
    new Root(kiten),
  );
  return { root, kiten };
}
