/**
 * Сообщение из разбора как объект: что оно значит для исполнителя и для
 * вида, решает оно само. Перевод из данных разбора — один, в `sentOf`.
 */

import type { Message } from "../messages/mod.ts";
import type {
  Args,
  Call,
  Entry,
  LinkTarget,
  Sent,
  Walker,
} from "./protocol.ts";
import { HELP_SELECTOR } from "./protocol.ts";

class UnarySent implements Sent {
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
}

class KeywordSent implements Sent {
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
  if (!("unary" in message)) return new KeywordSent(message.keyword);
  if (message.unary === HELP_SELECTOR) return HELP;
  return new UnarySent(message.unary);
}
