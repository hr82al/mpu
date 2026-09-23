/**
 * Узлы программы: что вычисляет каждая запись строки, решает её узел.
 * Узел держит промежуток своих слов — по нему отказ получает подсказку с
 * заменённым словом.
 */

import { literalWords } from "../messages/mod.ts";
import { misstep, type Span } from "./machine.ts";
import { Block, type Body, done, NIL, selectorOf } from "./objects.ts";
import type {
  Answer,
  Reach,
  Reply,
  Request,
  Stack,
  Value,
} from "./protocol.ts";
import type { Scope } from "./scope.ts";
import type { Place } from "./machine.ts";

/** Выражение: вычисляется в области имён. */
export interface Expression {
  evaluate(scope: Scope): Answer;
  /** Команды, до которых вычисление может дойти, — собирателю `into`. */
  reach(into: Reach): void;
}

/** Сообщение цепочки: уходит значению слева. */
export interface Message {
  sendTo(receiver: Value, scope: Scope): Answer;
  /** Команды в значениях сообщения — собирателю `into`. */
  reach(into: Reach): void;
}

/** Обход выражений по порядку. */
function reachAll(
  list: readonly { reach(into: Reach): void }[],
  into: Reach,
) {
  for (const one of list) one.reach(into);
}

/** Выражения тела блока или группы: итог — значение последнего. */
export class Statements implements Body {
  readonly #list: readonly Expression[];

  constructor(list: readonly Expression[]) {
    this.#list = list;
  }

  *run(scope: Scope): Answer {
    let last: Value = NIL;
    for (const expression of this.#list) {
      last = yield* expression.evaluate(scope);
    }
    return last;
  }

  reach(into: Reach) {
    reachAll(this.#list, into);
  }
}

/** Программа: выражения верхнего уровня, номер каждого — месту ошибки. */
export class Program {
  readonly #list: readonly Expression[];

  constructor(list: readonly Expression[]) {
    this.#list = list;
  }

  /** Ответ программы; `place` узнаёт номер идущего выражения. */
  *run(scope: Scope, place: Place): Answer {
    let last: Value = NIL;
    for (const [i, expression] of this.#list.entries()) {
      place.at(i + 1);
      last = yield* expression.evaluate(scope);
    }
    return last;
  }

  /** Команды, до которых программа может дойти, — собирателю `into`. */
  reach(into: Reach) {
    reachAll(this.#list, into);
  }
}

/** Готовое значение: число, текст. */
export class Constant implements Expression {
  readonly #value: Value;

  constructor(value: Value) {
    this.#value = value;
  }

  evaluate(): Answer {
    return done(this.#value);
  }

  reach() {}
}

/** Переменная: имя, связанное разбором; не присвоенное ещё — `nil`. */
export class Variable implements Expression {
  readonly #name: string;

  constructor(name: string) {
    this.#name = name;
  }

  evaluate(scope: Scope): Answer {
    return done(scope.find(this.#name, NIL));
  }

  reach() {}
}

/** Запись блока: блок замыкает область, в которой его вычислили. */
export class BlockLiteral implements Expression {
  readonly #params: readonly string[];
  readonly #body: Body;

  constructor(params: readonly string[], body: Body) {
    this.#params = params;
    this.#body = body;
  }

  evaluate(scope: Scope): Answer {
    return done(new Block(this.#params, this.#body, scope));
  }

  reach(into: Reach) {
    this.#body.reach(into);
  }
}

/** Группа `do … end`: выражения в той же области. */
export class Group implements Expression {
  readonly #body: Statements;

  constructor(body: Statements) {
    this.#body = body;
  }

  evaluate(scope: Scope): Answer {
    return this.#body.run(scope);
  }

  reach(into: Reach) {
    this.#body.reach(into);
  }
}

/** Присваивание: итог — присвоенное значение. */
export class Assignment implements Expression {
  readonly #name: string;
  readonly #value: Expression;

  constructor(name: string, value: Expression) {
    this.#name = name;
    this.#value = value;
  }

  *evaluate(scope: Scope): Answer {
    const value = yield* this.#value.evaluate(scope);
    scope.assign(this.#name, value);
    return value;
  }

  reach(into: Reach) {
    this.#value.reach(into);
  }
}

/** Цепочка: первичное выражение и сообщения его результатам по порядку. */
export class Chain implements Expression {
  readonly #primary: Expression;
  readonly #messages: readonly Message[];

  constructor(primary: Expression, messages: readonly Message[]) {
    this.#primary = primary;
    this.#messages = messages;
  }

  *evaluate(scope: Scope): Answer {
    let value = yield* this.#primary.evaluate(scope);
    for (const message of this.#messages) {
      value = yield* message.sendTo(value, scope);
    }
    return value;
  }

  reach(into: Reach) {
    this.#primary.reach(into);
    reachAll(this.#messages, into);
  }
}

/** Отправка с промежутком слов: отказ получает место в строке. */
function* sent(
  receiver: Value,
  selector: string,
  args: readonly Value[],
  span: Span,
): Answer {
  try {
    return yield* receiver.send(selector, args);
  } catch (err) {
    throw misstep(err, span);
  }
}

/** Унарное сообщение. */
export class Unary implements Message {
  readonly #selector: string;
  readonly #span: Span;

  constructor(selector: string, span: Span) {
    this.#selector = selector;
    this.#span = span;
  }

  sendTo(receiver: Value): Answer {
    return sent(receiver, this.#selector, [], this.#span);
  }

  reach() {}
}

/**
 * Ключевое сообщение: ключи подряд — одно сообщение; сколько первых
 * ключей понимает получатель, решает он сам, остаток уходит результату
 * (деление склеенного).
 */
export class Keyword implements Message {
  readonly #keys: readonly string[];
  readonly #args: readonly Expression[];
  readonly #span: Span;

  constructor(
    keys: readonly string[],
    args: readonly Expression[],
    span: Span,
  ) {
    this.#keys = keys;
    this.#args = args;
    this.#span = span;
  }

  *sendTo(receiver: Value, scope: Scope): Answer {
    const args: Value[] = [];
    for (const arg of this.#args) args.push(yield* arg.evaluate(scope));
    let value = receiver;
    let at = 0;
    while (at < this.#keys.length) {
      const rest = this.#keys.slice(at);
      // Не понимает ни одного — отказ даст сама отправка всего остатка.
      const taken = value.take(rest) || rest.length;
      const selector = selectorOf(rest.slice(0, taken));
      value = yield* sent(
        value,
        selector,
        args.slice(at, at + taken),
        this.#span,
      );
      at += taken;
    }
    return value;
  }

  reach(into: Reach) {
    reachAll(this.#args, into);
  }
}

/** Слова сегмента команды: какие они в строке ядру. */
export interface Part {
  spell(scope: Scope): Generator<Request, readonly string[], Value>;
  /** Команды в вычисляемых словах — собирателю `into`. */
  reach(into: Reach): void;
}

/** Слова как набраны: путь, ключи, литералы, `stdin`. */
export class Written implements Part {
  readonly #words: readonly string[];

  constructor(words: readonly string[]) {
    this.#words = words;
  }

  // deno-lint-ignore require-yield
  *spell(): Generator<Request, readonly string[], Value> {
    return this.#words;
  }

  reach() {}
}

/**
 * Значение ключа команды из выражения программы: его текстовый вид
 * (`platform/evaluator.md`, «Модель вычисления»), словом, которое разбор
 * ядра прочтёт буквально.
 */
export class Computed implements Part {
  readonly #key: string;
  readonly #value: Expression;
  readonly #span: Span;

  constructor(key: string, value: Expression, span: Span) {
    this.#key = key;
    this.#value = value;
    this.#span = span;
  }

  *spell(scope: Scope): Generator<Request, readonly string[], Value> {
    const value = yield* this.#value.evaluate(scope);
    try {
      return literalWords(value.spelled(this.#key));
    } catch (err) {
      throw misstep(err, this.#span);
    }
  }

  reach(into: Reach) {
    this.#value.reach(into);
  }
}

/** Как читается итог строки ядра: значением или напечатанным. */
export type Reading = (reply: Reply) => Value;

/** Результат команды — значением: его отбор, поля, вид. */
export const AS_VALUE: Reading = (reply) => reply.value();

/** Формат за командой: значение — напечатанный текст. */
export const AS_PRINTED: Reading = (reply) => reply.printed();

/** Строка ядру: ответ машины — итог команды, прочитанный `reading`. */
export class CoreLine implements Request {
  readonly #words: readonly string[];
  readonly #reading: Reading;

  constructor(words: readonly string[], reading: Reading) {
    this.#words = words;
    this.#reading = reading;
  }

  async enter(stack: Stack): Promise<void> {
    stack.resume(this.#reading(await stack.core(this.#words)));
  }
}

/** Кому команда программы уходит: обход до исполнения знает его или нет. */
export interface Addressee {
  reach(into: Reach): void;
}

/** Лист реестра, известный по разбору: путь и звенья пути правила. */
export class Known implements Addressee {
  readonly #path: readonly string[];
  readonly #links: readonly string[];

  constructor(path: readonly string[], links: readonly string[]) {
    this.#path = path;
    this.#links = links;
  }

  reach(into: Reach) {
    into.command(this.#path, this.#links);
  }
}

/**
 * Не лист (группа): какая команда уйдёт ядру, решится при отправке — её
 * решают правила в момент строки.
 */
export const UNKNOWN: Addressee = { reach() {} };

/**
 * Команда реестра, до которой дошла программа: её слова со значениями,
 * вычисленными в текст, уходят ядру отдельной строкой. Результат ядро
 * берёт из доставки команды; строке без команды (`it`, справка) нужен
 * `end json` — её данные читаются из напечатанного; формат за командой
 * уходит с ней — он меняет и исполнение, и печать.
 */
export class Command implements Expression {
  readonly #addressee: Addressee;
  readonly #parts: readonly Part[];
  readonly #closing: readonly string[];
  readonly #reading: Reading;

  /**
   * @param addressee команда, которой уйдёт строка, — для обхода
   * @param closing слова в конце строки ядру: формат команды, `end json`
   *   строки без команды или никаких
   * @param reading как читается итог: значением или напечатанным
   */
  constructor(
    addressee: Addressee,
    parts: readonly Part[],
    closing: readonly string[],
    reading: Reading,
  ) {
    this.#addressee = addressee;
    this.#parts = parts;
    this.#closing = closing;
    this.#reading = reading;
  }

  *evaluate(scope: Scope): Answer {
    const words: string[] = [];
    for (const part of this.#parts) words.push(...(yield* part.spell(scope)));
    return yield new CoreLine([...words, ...this.#closing], this.#reading);
  }

  reach(into: Reach) {
    this.#addressee.reach(into);
    reachAll(this.#parts, into);
  }
}
