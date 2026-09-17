/**
 * Сообщение из разбора как объект: что оно значит для исполнителя и для
 * вида, решает оно само. Перевод из данных разбора — один, в `sentOf`.
 */

import { ESCAPE_WORD, HELP_FLAG, type Message } from "../messages/mod.ts";
import type {
  Args,
  Call,
  Entry,
  Finder,
  LinkTarget,
  Named,
  Sent,
  Walker,
} from "./protocol.ts";
import { HELP_SELECTOR } from "./protocol.ts";

class UnarySent implements Named {
  readonly #word: string;

  constructor(word: string) {
    this.#word = word;
  }

  selector(): string {
    return this.#word;
  }

  text(): string {
    return this.#word;
  }

  args(): Args {
    return {};
  }

  enter(walker: Walker): Promise<void> {
    return walker.send(this);
  }

  viaLink(target: LinkTarget): Call {
    return target.word(this.#word);
  }

  route(finder: Finder): Call {
    return finder.named(this);
  }
}

class KeywordSent implements Named {
  readonly #args: Args;

  constructor(args: Args) {
    this.#args = args;
  }

  selector(): string {
    return Object.keys(this.#args).sort().map((key) => `${key}:`).join("");
  }

  /** Ключи со значениями в порядке строки. */
  text(): string {
    return Object.entries(this.#args)
      .map(([key, value]) => `${key}: ${value}`)
      .join(" ");
  }

  args(): Args {
    return this.#args;
  }

  enter(walker: Walker): Promise<void> {
    return walker.send(this);
  }

  viaLink(target: LinkTarget): Call {
    return target.refuse();
  }

  route(finder: Finder): Call {
    return finder.named(this);
  }
}

/** Слова хвоста, включающие режим справки: `help` и `--help`. */
const HELP_WORDS: ReadonlySet<string> = new Set([HELP_SELECTOR, HELP_FLAG]);

/** Хвост: остаток строки, который приёмник забирает как есть. */
class TailSent implements Sent {
  readonly #words: readonly string[];

  constructor(words: readonly string[]) {
    this.#words = words;
  }

  /** Первое слово: только для текста отказа. */
  selector(): string {
    return this.#words[0];
  }

  /**
   * Слова справки до первого `--` убираются и включают режим справки;
   * хвост, ставший пустым, сообщением не становится.
   */
  enter(walker: Walker): Promise<void> {
    // За `--` хвост справку не ищет (`platform/registry-objects.md`).
    const cut = this.#words.indexOf(ESCAPE_WORD);
    const end = cut < 0 ? this.#words.length : cut;
    const head = this.#words.slice(0, end);
    const kept = head.filter((word) => !HELP_WORDS.has(word));
    if (kept.length < head.length) walker.askHelp();
    const words = [...kept, ...this.#words.slice(end)];
    if (words.length === 0) return Promise.resolve();
    return walker.send(new TailSent(words));
  }

  viaLink(target: LinkTarget): Call {
    return target.words(this.#words);
  }

  route(finder: Finder): Call {
    return finder.tail();
  }
}

/** `help` из строки: не уходит объекту, а включает режим справки. */
const HELP: Entry = {
  enter(walker) {
    walker.askHelp();
    return Promise.resolve();
  },
};

/** Сообщение разбора как объект. */
export function sentOf(message: Message): Entry {
  if ("tail" in message) return new TailSent(message.tail);
  if ("keyword" in message) return new KeywordSent(message.keyword);
  if (message.unary === HELP_SELECTOR) return HELP;
  return new UnarySent(message.unary);
}
