/**
 * Методы вида: объявленные (унарные и ключевые), метод вида звена и
 * связанный вызов. Метод знает, что он такое; что он делает — функция,
 * которую дал автор объекта, и она получает состояние объекта.
 */

import type {
  KeyKind,
  KeywordMethod,
  ReceiverDescription,
} from "../messages/mod.ts";
import type {
  Args,
  Call,
  Doc,
  Named,
  ResultKind,
  Sent,
  Trace,
  Yields,
} from "./protocol.ts";

/** Строка раздела «Сообщения» справки. */
export interface Line {
  readonly selector: string;
  readonly purpose: string;
}

/** Описание приёмника для разбора, пока оно собирается. */
export class Description {
  readonly #unary: string[] = [];
  readonly #keyword: KeywordMethod[] = [];
  #tail: Pick<ReceiverDescription, "tail"> = {};

  unary(selector: string) {
    this.#unary.push(selector);
  }

  keyword(method: KeywordMethod) {
    this.#keyword.push(method);
  }

  /** Хвост у вида один: его объявляет ответ вида на непонятое. */
  tail(name: string) {
    this.#tail = { tail: name };
  }

  build(): ReceiverDescription {
    return {
      unary: [...this.#unary],
      keyword: [...this.#keyword],
      ...this.#tail,
    };
  }
}

/** Метод вида с объектом-состоянием `S`. */
export interface Method<S> {
  readonly selector: string;
  describe(into: Description): void;
  line(): Line;
  bind(self: S, sent: Named): Call;
}

/** Ответ вида на сообщение без своего и общего селектора. */
export interface Fallback<S> {
  understand(sent: Sent, self: S, refuse: () => Call): Call;
  lines(): Line[];
  /** Что ответ на непонятое добавляет в описание для разбора. */
  describe(into: Description): void;
}

/** Метод, связанный с приёмником и сообщением. */
class BoundCall<T> implements Call {
  readonly #link: string;
  readonly #text: string;
  readonly #doc: Doc;
  readonly #kind: Yields<T>;
  readonly #act: () => T | Promise<T>;

  constructor(
    link: string,
    text: string,
    doc: Doc,
    kind: Yields<T>,
    act: () => T | Promise<T>,
  ) {
    this.#link = link;
    this.#text = text;
    this.#doc = doc;
    this.#kind = kind;
    this.#act = act;
  }

  trace(trail: Trace) {
    trail.step(this.#link, this.#text);
  }

  result(): ResultKind {
    return this.#kind;
  }

  help(trail: Trace): string {
    return this.#kind.usage(trail.textWith(this.#text), this.#doc);
  }

  async perform() {
    return this.#kind.receive(await this.#act());
  }
}

/** Как метод входит в описание для разбора. */
interface Signature {
  describe(into: Description): void;
}

class Declared<S, T> implements Method<S> {
  readonly selector: string;
  readonly #signature: Signature;
  readonly #doc: Doc;
  readonly #kind: Yields<T>;
  readonly #run: (self: S, args: Args) => T | Promise<T>;

  constructor(
    selector: string,
    signature: Signature,
    doc: Doc,
    kind: Yields<T>,
    run: (self: S, args: Args) => T | Promise<T>,
  ) {
    this.selector = selector;
    this.#signature = signature;
    this.#doc = doc;
    this.#kind = kind;
    this.#run = run;
  }

  describe(into: Description) {
    this.#signature.describe(into);
  }

  line(): Line {
    return { selector: this.selector, purpose: this.#doc.purpose };
  }

  bind(self: S, sent: Named): Call {
    const args = sent.args();
    return new BoundCall(
      this.selector,
      sent.text(),
      this.#doc,
      this.#kind,
      () => this.#run(self, args),
    );
  }
}

/**
 * Унарный метод.
 *
 * @param selector слово сообщения
 * @param doc назначение и справка
 * @param kind вид результата: `DATA` или вид объекта
 * @param run что метод делает с состоянием объекта
 */
export function unary<S, T>(
  selector: string,
  doc: Doc,
  kind: Yields<T>,
  run: (self: S) => T | Promise<T>,
): Method<S> {
  const signature = { describe: (into: Description) => into.unary(selector) };
  return new Declared(selector, signature, doc, kind, (self) => run(self));
}

/**
 * Ключевой метод. Селектор — ключи по алфавиту, каждый с двоеточием.
 *
 * @param keys ключи и их вид
 * @param required обязательные ключи
 * @param doc назначение и справка
 * @param kind вид результата
 * @param run что метод делает с состоянием и значениями ключей
 */
export function keyword<S, T>(
  keys: Readonly<Record<string, KeyKind>>,
  required: readonly string[],
  doc: Doc,
  kind: Yields<T>,
  run: (self: S, args: Args) => T | Promise<T>,
): Method<S> {
  const selector = Object.keys(keys).sort().map((key) => `${key}:`).join("");
  const signature = {
    describe: (into: Description) => into.keyword({ keys, required }),
  };
  return new Declared(selector, signature, doc, kind, run);
}

/** Непонятое — отказ. Единственный null-объект модуля. */
export const REFUSE: Fallback<unknown> = {
  understand: (_sent, _self, refuse) => refuse(),
  lines: () => [],
  describe() {},
};

class LinkMethod<S, T> implements Fallback<S> {
  readonly #name: string;
  readonly #doc: Doc;
  readonly #kind: Yields<T>;
  readonly #run: (self: S, word: string) => T | Promise<T>;

  constructor(
    name: string,
    doc: Doc,
    kind: Yields<T>,
    run: (self: S, word: string) => T | Promise<T>,
  ) {
    this.#name = name;
    this.#doc = doc;
    this.#kind = kind;
    this.#run = run;
  }

  understand(sent: Sent, self: S, refuse: () => Call): Call {
    return sent.viaLink({
      word: (word) =>
        new BoundCall(
          this.#name,
          word,
          this.#doc,
          this.#kind,
          () => this.#run(self, word),
        ),
      words: refuse,
      refuse,
    });
  }

  lines(): Line[] {
    return [{ selector: this.#name, purpose: this.#doc.purpose }];
  }

  describe() {}
}

class TailMethod<S> implements Fallback<S> {
  readonly #name: string;
  readonly #doc: Doc;
  readonly #kind: () => Yields<S>;

  constructor(name: string, doc: Doc, kind: () => Yields<S>) {
    this.#name = name;
    this.#doc = doc;
    this.#kind = kind;
  }

  understand(sent: Sent, self: S, refuse: () => Call): Call {
    return sent.viaLink({
      word: refuse,
      words: (words) =>
        new BoundCall(
          this.#name,
          words.join(" "),
          this.#doc,
          this.#kind(),
          () => self,
        ),
      refuse,
    });
  }

  lines(): Line[] {
    return [{ selector: this.#name, purpose: this.#doc.purpose }];
  }

  describe(into: Description) {
    into.tail(this.#name);
  }
}

/**
 * Хвост: вид забирает остаток строки одним сообщением
 * (`platform/registry-objects.md`). Ответ — то же состояние в виде
 * `kind`; вид передаётся функцией, чтобы мог сослаться на самого себя.
 *
 * @param name вид звена хвоста в угловых скобках
 * @param doc назначение и справка
 * @param kind вид, которым станет состояние после хвоста
 */
export function tail<S>(
  name: string,
  doc: Doc,
  kind: () => Yields<S>,
): Fallback<S> {
  return new TailMethod(name, doc, kind);
}

/**
 * Метод вида звена: ответ на произвольное слово. В путь входит именем
 * вида (`<card>`), в справку — последней строкой. Отказать слову метод
 * может только при исполнении: справка к нему слово не проверяет.
 *
 * @param name вид звена в угловых скобках
 * @param doc назначение и справка
 * @param kind вид результата
 * @param run что метод делает со словом
 */
export function link<S, T>(
  name: string,
  doc: Doc,
  kind: Yields<T>,
  run: (self: S, word: string) => T | Promise<T>,
): Fallback<S> {
  return new LinkMethod(name, doc, kind, run);
}
