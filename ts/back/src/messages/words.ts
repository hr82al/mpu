/**
 * Слова строки вызова как объекты: что делает слово, решает оно само —
 * в начале шага, за законченной парой, на месте значения, за `--` и в
 * хвосте. Строка превращается в объект один раз, в `wordOf`.
 */

import { type Message, MessageParseError, StrayWord } from "./message.ts";
import type { Draft, Kind, Receiver, ValueSource } from "./receiver.ts";

/**
 * Слова грамматики (`platform/line-grammar.md` [D.1]): открытие группы,
 * закрытие и знак литерала. Литералом эти слова больше нигде не пишутся —
 * разбор, справка, подсказки и описание тула читают их отсюда.
 */
export const GRAMMAR = { open: "do", close: "end", literal: "--" } as const;

/** Слово строки, которое разбор читает как сообщение `help`. */
export const HELP_FLAG = "--help";

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
  /** Слово стоит за ключевым сообщением: закрывает его или лишнее. */
  afterPair(draft: Draft, words: Words): void;
  /** Слово в хвосте: кладёт себя в `into`; `false` — хвост кончился. */
  intoTail(words: Words, into: string[]): boolean;
  /** Начинает ли слово хвост у приёмника со своими селекторами `own`. */
  opensTail(own: ReadonlySet<string>): boolean;
}

/** Слова строки и позиция в них. */
export class Words implements ValueSource {
  readonly #list: readonly string[];
  #at = 0;

  constructor(list: readonly string[]) {
    this.#list = list;
  }

  /** Начинает ли очередное слово хвост приёмника со своими `own`. */
  opensTail(own: ReadonlySet<string>): boolean {
    return this.peek().opensTail(own);
  }

  /** Забирает все оставшиеся слова как есть. */
  takeAll(): string[] {
    const taken = this.rest();
    this.#at = this.#list.length;
    return taken;
  }

  /** Забирает слова хвоста — до закрытия без `--` перед ним. */
  takeTail(): string[] {
    const tail: string[] = [];
    while (this.peek().intoTail(this, tail)) continue;
    return tail;
  }

  /** Слова, забранные с начала шага, — как в строке. */
  consumed(): string[] {
    return this.#list.slice(0, this.#at);
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

  afterPair(draft: Draft, words: Words): never {
    throw new StrayWord(draft.last(), this.#text, words.consumed());
  }

  intoTail(words: Words, into: string[]): boolean {
    into.push(this.#text);
    words.skip();
    return true;
  }

  opensTail(own: ReadonlySet<string>): boolean {
    return !own.has(this.#text);
  }
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
    const draft = receiver.draft();
    this.#addTo(draft, words);
    while (words.peek().joinTo(draft, words)) continue;
    words.peek().afterPair(draft, words);
    return draft.finish();
  }

  joinTo(draft: Draft, words: Words): boolean {
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

  // Ключ за ключом всегда входит в то же сообщение (`joinTo`), поэтому
  // стоять за законченным ключевым сообщением он не может.
  afterPair() {}

  intoTail(words: Words, into: string[]): boolean {
    into.push(this.#text);
    words.skip();
    return true;
  }

  opensTail(): boolean {
    return true;
  }
}

/** Селектор справки: его шлёт слово `--help`. */
const HELP = "help";

/** `--help`: справка текущему приёмнику. */
const HELP_WORD: Word = {
  start: () => ({ unary: HELP }),
  joinTo: () => false,
  valueFor(key) {
    throw MessageParseError.noValue(key);
  },
  literal: () => HELP_FLAG,
  afterPair(draft, words) {
    throw new StrayWord(draft.last(), HELP_FLAG, words.consumed());
  },
  intoTail(words, into) {
    into.push(HELP_FLAG);
    words.skip();
    return true;
  },
  // `--help` — флаговая форма `help`: хвост начинает, только если
  // приёмник `help` не понимает.
  opensTail: (own) => !own.has(HELP),
};

/** `--`: следующее слово берётся буквально. */
const ESCAPE: Word = {
  start: (words) => ({ unary: words.literal() }),
  joinTo: () => false,
  valueFor: (_key, words) => words.literal(),
  literal: () => GRAMMAR.literal,
  afterPair(draft, words) {
    const taken = words.consumed();
    words.skip();
    throw new StrayWord(draft.last(), words.literal(), taken);
  },
  // Перед словом грамматики знак снимается, слово остаётся словом
  // хвоста; перед прочими словами знак — сам слово хвоста.
  intoTail(words, into) {
    words.skip();
    const next = words.peek();
    if (!GRAMMATICAL.has(next)) {
      into.push(GRAMMAR.literal);
      return true;
    }
    into.push(next.literal());
    words.skip();
    return true;
  },
  opensTail: () => true,
};

/** `do` не первым словом строки. */
function openElsewhere(): MessageParseError {
  return new MessageParseError(`${GRAMMAR.open} — только в начале строки`);
}

/** `do` — открытие группы; первым словом его снимает исполнитель строки. */
const OPEN: Word = {
  start() {
    throw openElsewhere();
  },
  joinTo: () => false,
  valueFor() {
    throw openElsewhere();
  },
  literal: () => GRAMMAR.open,
  afterPair() {
    throw openElsewhere();
  },
  intoTail(words, into) {
    into.push(GRAMMAR.open);
    words.skip();
    return true;
  },
  opensTail: () => true,
};

/** `end` — закрытие: всё до него выражение, дальше — его результату. */
const CLOSE: Word = {
  start: () => ({ close: true }),
  joinTo: () => false,
  valueFor(key) {
    throw MessageParseError.noValue(key);
  },
  literal: () => GRAMMAR.close,
  afterPair() {},
  intoTail: () => false,
  opensTail: () => false,
};

/** Конец слов. Пустая строка — справка корню. */
const END: Word = {
  start: () => ({ unary: HELP }),
  joinTo: () => false,
  valueFor(key) {
    throw MessageParseError.noValue(key);
  },
  literal() {
    throw new MessageParseError(`после ${GRAMMAR.literal} нет слова`);
  },
  afterPair() {},
  intoTail: () => false,
  opensTail: () => false,
};

/** Слова грамматики, перед которыми `--` в хвосте снимается. */
const GRAMMATICAL: ReadonlySet<Word> = new Set([OPEN, CLOSE]);

const EXACT: ReadonlyMap<string, Word> = new Map([
  [GRAMMAR.literal, ESCAPE],
  [GRAMMAR.open, OPEN],
  [GRAMMAR.close, CLOSE],
  [HELP_FLAG, HELP_WORD],
]);

/** Слово строки как объект. Ключ — только с непустым именем. */
/** Приставка ключа в форме флага (`--ключ`); знак литерала — иное слово. */
const DASHES = "--";

function wordOf(text: string): Word {
  const exact = EXACT.get(text);
  if (exact !== undefined) return exact;
  if (text.startsWith(DASHES)) return dashed(text);
  if (text.length > 1 && text.endsWith(":")) {
    return new Key(text.slice(0, -1), text, COLON);
  }
  return new Bare(text);
}

function dashed(text: string): Word {
  const body = text.slice(DASHES.length);
  const eq = body.indexOf("=");
  if (eq < 0) return new Key(body, text, DASH);
  if (eq === 0) return new Bare(text);
  return new Key(body.slice(0, eq), text, new Inline(body.slice(eq + 1)));
}
