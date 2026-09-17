/**
 * Слова строки вызова как объекты: что делает слово, решает оно само —
 * в начале шага, за законченной парой, на месте значения, за `--` и за
 * точкой. Строка превращается в объект один раз, в `wordOf`.
 */

import { type Message, MessageParseError } from "./message.ts";
import type { Draft, Kind, Receiver, ValueSource } from "./receiver.ts";

/** Слово строки вызова. */
interface Word {
  /** Слово начинает шаг: какое сообщение получит текущий приёмник. */
  start(words: Words, receiver: Receiver): Message;
  /** Слово стоит за законченной парой: входит ли оно в сообщение. */
  joinTo(draft: Draft, words: Words): boolean;
  /** Слово стоит там, где ключ `key` ждёт значения. */
  valueFor(key: string, words: Words): string;
  /** Слово стоит за `--`: берётся буквально. */
  literal(): string;
  /** Слово стоит за точкой, закрывшей сообщение. */
  afterDot(): void;
  /** Слово стоит сразу за законченным сообщением. */
  close(words: Words): void;
}

/** Слова строки и позиция в них. */
export class Words implements ValueSource {
  readonly #list: readonly string[];
  #at = 0;

  constructor(list: readonly string[]) {
    this.#list = list;
  }

  /** Лежит ли в начале слово, которого нет в `known`; слов нет — нет. */
  firstOutside(known: ReadonlySet<string>): boolean {
    if (this.#at >= this.#list.length) return false;
    return !known.has(this.#list[this.#at]);
  }

  /** Забирает все оставшиеся слова как есть. */
  takeAll(): string[] {
    const taken = this.rest();
    this.#at = this.#list.length;
    return taken;
  }

  /** Очередное слово, не забирая его; за концом — `END`. */
  peek(): Word {
    if (this.#at >= this.#list.length) return END;
    return wordOf(this.#list[this.#at]);
  }

  /** Очередное слово, забирая его. */
  next(): Word {
    const word = this.peek();
    this.skip();
    return word;
  }

  skip() {
    this.#at = Math.min(this.#at + 1, this.#list.length);
  }

  valueFor(key: string): string {
    return this.next().valueFor(key, this);
  }

  /** Слово за `--`, взятое буквально. */
  literal(): string {
    return this.next().literal();
  }

  /** Незабранные слова — копией. */
  rest(): string[] {
    return this.#list.slice(this.#at);
  }
}

/** Слово без особого смысла: унарное сообщение или значение. */
class Bare implements Word {
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  start(): Message {
    return { unary: this.#text };
  }

  joinTo(): boolean {
    return false;
  }

  valueFor(): string {
    return this.#text;
  }

  literal(): string {
    return this.#text;
  }

  afterDot() {}

  close() {}
}

/** Как форма записи ключа получает значение. */
interface KeyForm {
  read(key: string, kind: Kind, words: Words): string | boolean;
}

/** `ключ:` — значение в следующем слове. */
const COLON: KeyForm = {
  read: (key, kind, words) => kind.fromText(key, words.valueFor(key)),
};

/** `--ключ` — значение в следующем слове, флагу оно не нужно. */
const DASH: KeyForm = {
  read: (key, kind, words) => kind.bare(key, words),
};

/** `--ключ=текст` — значение в том же слове. */
class Inline implements KeyForm {
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  read(key: string, kind: Kind): string | boolean {
    return kind.fromText(key, this.#text);
  }
}

/** Слово-ключ в любой из трёх форм. */
class Key implements Word {
  readonly #name: string;
  readonly #text: string;
  readonly #form: KeyForm;

  constructor(name: string, text: string, form: KeyForm) {
    this.#name = name;
    this.#text = text;
    this.#form = form;
  }

  start(words: Words, receiver: Receiver): Message {
    const draft = receiver.draft(this.#name);
    this.#addTo(draft, words);
    while (words.peek().joinTo(draft, words)) continue;
    return draft.finish();
  }

  joinTo(draft: Draft, words: Words): boolean {
    if (!draft.accepts(this.#name)) return false;
    words.skip();
    this.#addTo(draft, words);
    return true;
  }

  #addTo(draft: Draft, words: Words) {
    draft.take(this.#name, (kind) => this.#form.read(this.#name, kind, words));
  }

  valueFor(key: string): string {
    throw MessageParseError.noValue(key);
  }

  literal(): string {
    return this.#text;
  }

  afterDot() {}

  close() {}
}

/** Слово строки, за которым следующее слово берётся буквально. */
export const ESCAPE_WORD = "--";

/** Слово строки, которое разбор читает как сообщение `help`. */
export const HELP_FLAG = "--help";

/** `--help`: справка текущему приёмнику. */
const HELP: Word = {
  start: () => ({ unary: "help" }),
  joinTo: () => false,
  valueFor(key) {
    throw MessageParseError.noValue(key);
  },
  literal: () => HELP_FLAG,
  afterDot() {},
  close() {},
};

/** `.`: граница между сообщениями. */
const DOT: Word = {
  start() {
    throw new MessageParseError("перед точкой нет сообщения");
  },
  joinTo: () => false,
  valueFor(key) {
    throw MessageParseError.noValue(key);
  },
  literal: () => ".",
  // Вторая точка подряд — не забота закрывшего шага: следующий шаг
  // начнётся с неё и ответит «перед точкой нет сообщения» (`start`).
  afterDot() {},
  close(words) {
    words.skip();
    words.peek().afterDot();
  },
};

/** `--`: следующее слово берётся буквально. */
const ESCAPE: Word = {
  start: (words) => ({ unary: words.literal() }),
  joinTo: () => false,
  valueFor: (_key, words) => words.literal(),
  literal: () => "--",
  afterDot() {},
  close() {},
};

/** Конец слов. Пустая строка — справка корню. */
const END: Word = {
  start: () => ({ unary: "help" }),
  joinTo: () => false,
  valueFor(key) {
    throw MessageParseError.noValue(key);
  },
  literal() {
    throw new MessageParseError("после -- нет слова");
  },
  afterDot() {
    throw new MessageParseError("после точки нет сообщения");
  },
  close() {},
};

const EXACT: ReadonlyMap<string, Word> = new Map([
  [".", DOT],
  [ESCAPE_WORD, ESCAPE],
  [HELP_FLAG, HELP],
]);

/** Слово строки как объект. Ключ — только с непустым именем. */
function wordOf(text: string): Word {
  const exact = EXACT.get(text);
  if (exact !== undefined) return exact;
  if (text.startsWith("--")) return dashed(text);
  if (text.length > 1 && text.endsWith(":")) {
    return new Key(text.slice(0, -1), text, COLON);
  }
  return new Bare(text);
}

function dashed(text: string): Word {
  const body = text.slice(2);
  const eq = body.indexOf("=");
  if (eq < 0) return new Key(body, text, DASH);
  if (eq === 0) return new Bare(text);
  return new Key(body.slice(0, eq), text, new Inline(body.slice(eq + 1)));
}
