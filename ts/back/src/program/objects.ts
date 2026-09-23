/**
 * Базовые объекты программы (`platform/evaluator.md`, «Базовые
 * объекты»): число, текст, `true` и `false`, `nil`, блок, список,
 * напечатанное форматом. Что понимает объект, объявляет его протокол —
 * таблица «селектор → назначение и ответ»; из неё же выводятся деление
 * склеенного ключевого, ближайшие к непонятому и отражение.
 */

import { jsonText, nearest, notUnderstood, Refusal } from "../objects/mod.ts";
import type { Answer, Operand, Request, Stack, Value } from "./protocol.ts";
import type { Scope } from "./scope.ts";

/** Метод значения вида `T`: назначение и ответ. */
export interface Method<T> {
  readonly purpose: string;
  answer(self: T, args: readonly Value[]): Answer;
}

/** Ключевой селектор из ключей по порядку строки: `to`, `do` → `to:do:`. */
export function selectorOf(keys: readonly string[]): string {
  return keys.map((key) => `${key}:`).join("");
}

/** Ответ без запросов машине. */
// deno-lint-ignore require-yield
export function* done(value: Value): Answer {
  return value;
}

/** Вызов блока: кадр в стек машины, итог — тому, кто позвал. */
class BlockCall implements Request {
  readonly #activation: Answer;
  readonly #label: string;

  constructor(activation: Answer, label: string) {
    this.#activation = activation;
    this.#label = label;
  }

  enter(stack: Stack): Promise<void> {
    stack.push(this.#activation, this.#label);
    return Promise.resolve();
  }
}

/** Печать `print`: текст — в stdout строки, ответ — `nil`. */
export class Printing implements Request {
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  enter(stack: Stack): Promise<void> {
    stack.print(this.#text);
    stack.resume(NIL);
    return Promise.resolve();
  }
}

/** Отказ вычисления с видом — постоянной строкой. */
function refused(text: string, reason: string = text): Refusal {
  return new Refusal(text, { reason });
}

const DIVISION_BY_ZERO = "деление на ноль";
const MIXED = "сравнение числа и текста";
const NOT_SCALAR = "значение ключа — не скаляр";

/** Значение не скаляр: значением ключа команды оно не годится. */
export function notScalar(key: string, kind: string): Refusal {
  return refused(`значение ключа ${key} — не скаляр (${kind})`, NOT_SCALAR);
}

/**
 * Протокол вида значения: свои методы, общие для всех и отказ
 * непонятому. Общие (печать, `isNil`, отражение, `json`) — одно место на
 * все виды; свой метод с тем же селектором их заменяет (`nil isNil`).
 */
export class Protocol<T extends Value> {
  readonly #kind: string;
  readonly #methods: ReadonlyMap<string, Method<T>>;

  /**
   * @param kind имя вида в тексте отказа: `число не понимает …`
   * @param own свои методы
   */
  constructor(kind: string, own: Readonly<Record<string, Method<T>>>) {
    this.#kind = kind;
    this.#methods = new Map([
      ...Object.entries(common(this)),
      ...Object.entries(own),
    ]);
  }

  /** Сколько первых ключей — одно своё сообщение; самое длинное. */
  take(keys: readonly string[]): number {
    for (let n = keys.length; n > 0; n--) {
      if (this.#methods.has(selectorOf(keys.slice(0, n)))) return n;
    }
    return 0;
  }

  send(self: T, selector: string, args: readonly Value[]): Answer {
    const method = this.#methods.get(selector);
    if (method === undefined) throw this.refusal(selector);
    return method.answer(self, args);
  }

  understands(selector: string): boolean {
    return this.#methods.has(selector);
  }

  /**
   * Отказ `doesNotUnderstand` с ближайшими из своих, общих и `more` —
   * сообщений, которые значение понимает сверх протокола.
   */
  refusal(selector: string, more: readonly string[] = []): Refusal {
    const known = [...this.#methods.keys(), ...more].sort();
    const close = nearest(selector, known);
    return notUnderstood(
      `${this.#kind} не понимает ${selector}`,
      selector,
      close,
      "ближайшие",
    );
  }

  /** Сообщения текстом: `<селектор>\t<назначение>` по алфавиту. */
  lines(): string {
    return [...this.#methods.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([selector, method]) => `${selector}\t${method.purpose}\n`)
      .join("");
  }

  /** Справка вида: имя и сообщения. */
  help(): string {
    return `${this.#kind}\n\n${this.lines()}`;
  }
}

/** Общие сообщения любого значения вида с протоколом `protocol`. */
function common<T extends Value>(
  protocol: Protocol<T>,
): Record<string, Method<T>> {
  return {
    print: {
      purpose: "напечатать значение; ответ — nil",
      *answer(self) {
        yield new Printing(self.shown());
        return NIL;
      },
    },
    isNil: { purpose: "nil ли это", answer: () => done(FALSE) },
    json: {
      purpose: "данные значения JSON",
      answer: (self) => done(new Printed(jsonText(self.json()))),
    },
    messages: {
      purpose: "сообщения значения",
      answer: () => done(new Printed(protocol.lines())),
    },
    "understands:": {
      purpose: "понимает ли значение сообщение",
      answer: (_self, [selector]) =>
        done(truth(protocol.understands(selector.spelled("understands")))),
    },
    keys: { purpose: "ключи команды — нет", answer: () => done(EMPTY) },
    formats: {
      purpose: "форматы значения",
      answer: () => done(new List([new Text("json")])),
    },
    variants: { purpose: "варианты команды — нет", answer: () => done(EMPTY) },
    help: {
      purpose: "справка значения",
      answer: () => done(new Printed(protocol.help())),
    },
  };
}

/** Код точки строки, как `codePointAt`: порядок по кодовым точкам. */
function codeOrder(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const diff = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return x.length - y.length;
}

/** Операнд-число. */
class NumberOperand implements Operand {
  readonly #n: number;

  constructor(n: number) {
    this.#n = n;
  }

  amount(): number {
    return this.#n;
  }

  fromNumber(n: number): number {
    return n - this.#n;
  }

  fromText(): number {
    throw refused(MIXED);
  }

  isNumber(n: number): boolean {
    return n === this.#n;
  }

  isText(): boolean {
    return false;
  }

  within(t: string): boolean {
    return t.toLowerCase().includes(numberText(this.#n));
  }
}

/** Операнд-текст. */
class TextOperand implements Operand {
  readonly #t: string;

  constructor(t: string) {
    this.#t = t;
  }

  amount(selector: string): number {
    throw refused(`${selector} ждёт число`, "ждёт число");
  }

  fromNumber(): number {
    throw refused(MIXED);
  }

  fromText(t: string): number {
    return codeOrder(t, this.#t);
  }

  isNumber(): boolean {
    return false;
  }

  isText(t: string): boolean {
    return t === this.#t;
  }

  within(t: string): boolean {
    return t.toLowerCase().includes(this.#t.toLowerCase());
  }
}

/** Не число и не текст: арифметике и сравнению не годится. */
export const NO_OPERAND: Operand = {
  amount(selector) {
    throw refused(`${selector} ждёт число`, "ждёт число");
  },
  fromNumber() {
    throw refused("не сравнивается");
  },
  fromText() {
    throw refused("не сравнивается");
  },
  isNumber: () => false,
  isText: () => false,
  within: () => false,
};

/** Не блок: вызова значением не понимает. */
export function notBlock<T extends Value>(
  protocol: Protocol<T>,
  args: readonly Value[],
): never {
  const selector = args.length === 0 ? "value" : "value:".repeat(args.length);
  throw protocol.refusal(selector);
}

/** Не булево: условием итога блока `by` не годится. */
export function notCondition(by: string): never {
  throw refused(`${by} ждёт true или false`, "ждёт true или false");
}

/** Текст числа, как его пишут: `7`, `2.5`, `-3`. */
function numberText(n: number): string {
  return String(n);
}

/** Операция над числом получателя и числом аргумента. */
function arithmetic(
  selector: string,
  purpose: string,
  apply: (a: number, b: number) => number,
): Method<Num> {
  return {
    purpose,
    answer: (self, [other]) =>
      done(new Num(apply(self.value(), other.operand().amount(selector)))),
  };
}

/** Делитель не ноль — иначе отказ. */
function divisor(n: number): number {
  if (n === 0) throw refused(DIVISION_BY_ZERO);
  return n;
}

const NUMBER: Protocol<Num> = new Protocol<Num>("число", {
  "plus:": arithmetic("plus:", "сумма", (a, b) => a + b),
  "minus:": arithmetic("minus:", "разность", (a, b) => a - b),
  "times:": arithmetic("times:", "произведение", (a, b) => a * b),
  "div:": arithmetic(
    "div:",
    "целое частное с округлением вниз",
    (a, b) => Math.floor(a / divisor(b)),
  ),
  "dividedBy:": arithmetic(
    "dividedBy:",
    "точное частное",
    (a, b) => a / divisor(b),
  ),
  "greater:": {
    purpose: "больше ли аргумента",
    answer: (self, [other]) =>
      done(truth(other.operand().fromNumber(self.value()) > 0)),
  },
  "less:": {
    purpose: "меньше ли аргумента",
    answer: (self, [other]) =>
      done(truth(other.operand().fromNumber(self.value()) < 0)),
  },
  "equals:": {
    purpose: "равно ли аргументу",
    answer: (self, [other]) =>
      done(truth(other.operand().isNumber(self.value()))),
  },
  "timesRepeat:": {
    purpose: "вызвать блок столько раз",
    *answer(self, [block]) {
      for (let i = 1; i <= self.value(); i++) {
        yield* block.evaluated([], "timesRepeat:");
      }
      return NIL;
    },
  },
  "to:do:": {
    purpose: "вызвать блок с каждым числом до аргумента включительно",
    *answer(self, [last, block]) {
      const end = last.operand().amount("to:");
      for (let i = self.value(); i <= end; i++) {
        yield* block.evaluated([new Num(i)], "to:do:");
      }
      return NIL;
    },
  },
});

/** Число. */
export class Num implements Value {
  readonly #n: number;

  constructor(n: number) {
    this.#n = n;
  }

  /** Число для методов своего протокола. */
  value(): number {
    return this.#n;
  }

  take(keys: readonly string[]): number {
    return NUMBER.take(keys);
  }

  send(selector: string, args: readonly Value[]): Answer {
    return NUMBER.send(this, selector, args);
  }

  shown(): string {
    return `${this.line()}\n`;
  }

  line(): string {
    return numberText(this.#n);
  }

  spelled(): string {
    return this.line();
  }

  operand(): Operand {
    return new NumberOperand(this.#n);
  }

  evaluated(args: readonly Value[]): Answer {
    return notBlock(NUMBER, args);
  }

  condition(by: string): boolean {
    return notCondition(by);
  }

  json(): unknown {
    return this.#n;
  }
}

const TEXT: Protocol<Text> = new Protocol<Text>("текст", {
  "equals:": {
    purpose: "равен ли аргументу",
    answer: (self, [other]) => done(truth(other.operand().isText(self.text()))),
  },
  "includes:": {
    purpose: "содержит ли аргумент без учёта регистра",
    answer: (self, [other]) => done(truth(other.operand().within(self.text()))),
  },
  size: {
    purpose: "число символов",
    answer: (self) => done(new Num([...self.text()].length)),
  },
  "greater:": {
    purpose: "дальше ли аргумента по кодовым точкам",
    answer: (self, [other]) =>
      done(truth(other.operand().fromText(self.text()) > 0)),
  },
  "less:": {
    purpose: "ближе ли аргумента по кодовым точкам",
    answer: (self, [other]) =>
      done(truth(other.operand().fromText(self.text()) < 0)),
  },
});

/** Текст. */
export class Text implements Value {
  readonly #t: string;

  constructor(t: string) {
    this.#t = t;
  }

  /** Текст для методов своего протокола. */
  text(): string {
    return this.#t;
  }

  take(keys: readonly string[]): number {
    return TEXT.take(keys);
  }

  send(selector: string, args: readonly Value[]): Answer {
    return TEXT.send(this, selector, args);
  }

  shown(): string {
    return `${this.#t}\n`;
  }

  line(): string {
    return this.#t;
  }

  spelled(): string {
    return this.#t;
  }

  operand(): Operand {
    return new TextOperand(this.#t);
  }

  evaluated(args: readonly Value[]): Answer {
    return notBlock(TEXT, args);
  }

  condition(by: string): boolean {
    return notCondition(by);
  }

  json(): unknown {
    return this.#t;
  }
}

/** Ветка условия: блок вызывается ради сообщения `by`. */
function branch(block: Value, by: string): Answer {
  return block.evaluated([], by);
}

/** Булево: истина и ложь — два объекта, у каждого свой протокол. */
class Truth implements Value {
  readonly #yes: boolean;
  readonly #protocol: Protocol<Truth>;

  constructor(yes: boolean, protocol: Protocol<Truth>) {
    this.#yes = yes;
    this.#protocol = protocol;
  }

  take(keys: readonly string[]): number {
    return this.#protocol.take(keys);
  }

  send(selector: string, args: readonly Value[]): Answer {
    return this.#protocol.send(this, selector, args);
  }

  condition(): boolean {
    return this.#yes;
  }

  shown(): string {
    return `${this.line()}\n`;
  }

  line(): string {
    return String(this.#yes);
  }

  spelled(): string {
    return this.line();
  }

  operand(): Operand {
    return NO_OPERAND;
  }

  evaluated(args: readonly Value[]): Answer {
    return notBlock(this.#protocol, args);
  }

  json(): unknown {
    return this.#yes;
  }
}

const TRUE_PROTOCOL: Protocol<Truth> = new Protocol<Truth>("булево", {
  "ifTrue:": {
    purpose: "вызвать блок, если истина",
    answer: (_self, [yes]) => branch(yes, "ifTrue:"),
  },
  "ifFalse:": {
    purpose: "вызвать блок, если ложь",
    answer: () => done(NIL),
  },
  "ifTrue:ifFalse:": {
    purpose: "первый блок, если истина, иначе второй",
    answer: (_self, [yes]) => branch(yes, "ifTrue:ifFalse:"),
  },
  "and:": {
    purpose: "итог блока, если истина",
    answer: (_self, [block]) => branch(block, "and:"),
  },
  "or:": { purpose: "истина или итог блока", answer: () => done(TRUE) },
  not: { purpose: "отрицание", answer: () => done(FALSE) },
});

const FALSE_PROTOCOL: Protocol<Truth> = new Protocol<Truth>("булево", {
  "ifTrue:": {
    purpose: "вызвать блок, если истина",
    answer: () => done(NIL),
  },
  "ifFalse:": {
    purpose: "вызвать блок, если ложь",
    answer: (_self, [no]) => branch(no, "ifFalse:"),
  },
  "ifTrue:ifFalse:": {
    purpose: "первый блок, если истина, иначе второй",
    answer: (_self, [, no]) => branch(no, "ifTrue:ifFalse:"),
  },
  "and:": { purpose: "ложь или итог блока", answer: () => done(FALSE) },
  "or:": {
    purpose: "итог блока, если ложь",
    answer: (_self, [block]) => branch(block, "or:"),
  },
  not: { purpose: "отрицание", answer: () => done(TRUE) },
});

/** Истина. */
export const TRUE: Value = new Truth(true, TRUE_PROTOCOL);
/** Ложь. */
export const FALSE: Value = new Truth(false, FALSE_PROTOCOL);

/** Булево значение условия. */
export function truth(condition: boolean): Value {
  return condition ? TRUE : FALSE;
}

const NIL_PROTOCOL: Protocol<Value> = new Protocol<Value>("nil", {
  isNil: { purpose: "nil ли это — да", answer: () => done(TRUE) },
});

/**
 * `nil`: нет значения — итог `print`, `each:`, невыбранной ветки,
 * ненайденного `detect:`, `null` данных. Не печатается. Единственный
 * null-объект модуля.
 */
export const NIL: Value = {
  take: (keys) => NIL_PROTOCOL.take(keys),
  send: (selector, args) => NIL_PROTOCOL.send(NIL, selector, args),
  shown: () => "",
  line: () => "",
  spelled: (key) => {
    throw notScalar(key, "nil");
  },
  operand: () => NO_OPERAND,
  evaluated: (args) => notBlock(NIL_PROTOCOL, args),
  condition: (by) => notCondition(by),
  json: () => null,
};

/** Тело блока: исполняется в области с параметрами. */
export interface Body {
  run(scope: Scope): Answer;
}

/** Сообщение вызова блока со столькими значениями: `value`, `value:value:`. */
function valueSelector(count: number): string {
  return count === 0 ? "value" : "value:".repeat(count);
}

const BLOCK: Protocol<Block> = new Protocol<Block>(
  "блок",
  Object.fromEntries(
    [0, 1, 2, 3].map((count) => [
      valueSelector(count),
      {
        purpose: `вызвать блок с ${count} значениями`,
        answer: (self: Block, args: readonly Value[]) =>
          self.evaluated(args, valueSelector(count)),
      },
    ]),
  ),
);

/** Блок: параметры, тело и область, в которой его записали. */
export class Block implements Value {
  readonly #params: readonly string[];
  readonly #body: Body;
  readonly #scope: Scope;

  constructor(params: readonly string[], body: Body, scope: Scope) {
    this.#params = params;
    this.#body = body;
    this.#scope = scope;
  }

  take(keys: readonly string[]): number {
    return BLOCK.take(keys);
  }

  send(selector: string, args: readonly Value[]): Answer {
    return BLOCK.send(this, selector, args);
  }

  shown(): string {
    return "блок\n";
  }

  line(): string {
    return "блок";
  }

  spelled(key: string): string {
    throw notScalar(key, "блок");
  }

  operand(): Operand {
    return NO_OPERAND;
  }

  /** Итог — значение последнего выражения тела. */
  *evaluated(args: readonly Value[], by: string): Answer {
    if (args.length !== this.#params.length) {
      throw refused(
        `блок ждёт ${this.#params.length} значений, дано ${args.length}`,
        "блок ждёт других значений",
      );
    }
    const scope = this.#scope.inner(this.#params, args);
    return yield new BlockCall(this.#body.run(scope), `блок ${by}`);
  }

  condition(by: string): boolean {
    return notCondition(by);
  }

  json(): unknown {
    return "блок";
  }
}

/** Элементы, по которым идут `each:` и соседи. */
export interface Enumerable extends Value {
  elements(): readonly Value[];
}

/**
 * Перечисление коллекции блоком — общее у списка программы и коллекции
 * данных: `each:`, `collect:`, `select:`, `reject:`, `detect:`,
 * `inject:into:`.
 */
export function enumeration<T extends Enumerable>(): Record<
  string,
  Method<T>
> {
  return {
    "each:": {
      purpose: "вызвать блок с каждым элементом",
      *answer(self, [block]) {
        for (const item of self.elements()) {
          yield* block.evaluated([item], "each:");
        }
        return NIL;
      },
    },
    "collect:": {
      purpose: "список итогов блока",
      *answer(self, [block]) {
        const got: Value[] = [];
        for (const item of self.elements()) {
          got.push(yield* block.evaluated([item], "collect:"));
        }
        return new List(got);
      },
    },
    "select:": {
      purpose: "элементы, для которых блок — true",
      answer: (self, [block]) => kept(self, block, "select:", true),
    },
    "reject:": {
      purpose: "элементы, для которых блок — false",
      answer: (self, [block]) => kept(self, block, "reject:", false),
    },
    "detect:": {
      purpose: "первый элемент, для которого блок — true; нет — nil",
      *answer(self, [block]) {
        for (const item of self.elements()) {
          const hit = yield* block.evaluated([item], "detect:");
          if (hit.condition("detect:")) return item;
        }
        return NIL;
      },
    },
    "inject:into:": {
      purpose: "свёртка: блок со значением и элементом",
      *answer(self, [start, block]) {
        let sum = start;
        for (const item of self.elements()) {
          sum = yield* block.evaluated([sum, item], "inject:into:");
        }
        return sum;
      },
    },
  };
}

/** Элементы, для которых итог блока равен `wanted`. */
function* kept(
  self: Enumerable,
  block: Value,
  by: string,
  wanted: boolean,
): Answer {
  const got: Value[] = [];
  for (const item of self.elements()) {
    const verdict = yield* block.evaluated([item], by);
    if (verdict.condition(by) === wanted) got.push(item);
  }
  return new List(got);
}

const LIST: Protocol<List> = new Protocol<List>("список", {
  ...enumeration<List>(),
  size: {
    purpose: "число элементов",
    answer: (self) => done(new Num(self.elements().length)),
  },
  isEmpty: {
    purpose: "пуст ли список",
    answer: (self) => done(truth(self.elements().length === 0)),
  },
  first: {
    purpose: "первый элемент; пустой — nil",
    answer: (self) => done(self.elements().at(0) ?? NIL),
  },
  last: {
    purpose: "последний элемент; пустой — nil",
    answer: (self) => done(self.elements().at(-1) ?? NIL),
  },
});

/** Список значений программы: итог `collect:`, `select:`, `reject:`. */
export class List implements Enumerable {
  readonly #items: readonly Value[];

  constructor(items: readonly Value[]) {
    this.#items = items;
  }

  elements(): readonly Value[] {
    return this.#items;
  }

  take(keys: readonly string[]): number {
    return LIST.take(keys);
  }

  send(selector: string, args: readonly Value[]): Answer {
    return LIST.send(this, selector, args);
  }

  shown(): string {
    return this.#items.map((item) => `${item.line()}\n`).join("");
  }

  line(): string {
    return JSON.stringify(this.json());
  }

  spelled(key: string): string {
    throw notScalar(key, "список");
  }

  operand(): Operand {
    return NO_OPERAND;
  }

  evaluated(args: readonly Value[]): Answer {
    return notBlock(LIST, args);
  }

  condition(by: string): boolean {
    return notCondition(by);
  }

  json(): unknown {
    return this.#items.map((item) => item.json());
  }
}

/** Пустой список: ключи и варианты значения, которых нет. */
const EMPTY: Value = new List([]);

const PRINTED: Protocol<Printed> = new Protocol<Printed>("текст", {});

/**
 * Напечатанное форматом (`kiten ls end json`): текст, который печатается
 * своими байтами как есть; сообщения — как у текста.
 */
export class Printed implements Value {
  readonly #shown: string;
  readonly #text: Text;

  constructor(shown: string) {
    this.#shown = shown;
    this.#text = new Text(shown.replace(/\n$/, ""));
  }

  take(keys: readonly string[]): number {
    return this.#text.take(keys);
  }

  /** Печать — своими байтами; прочее — тексту. */
  send(selector: string, args: readonly Value[]): Answer {
    if (selector === "print") return PRINTED.send(this, selector, args);
    return this.#text.send(selector, args);
  }

  shown(): string {
    return this.#shown;
  }

  line(): string {
    return this.#text.line();
  }

  spelled(): string {
    return this.#text.spelled();
  }

  operand(): Operand {
    return this.#text.operand();
  }

  evaluated(args: readonly Value[]): Answer {
    return this.#text.evaluated(args);
  }

  condition(by: string): boolean {
    return this.#text.condition(by);
  }

  json(): unknown {
    return this.#text.json();
  }
}
