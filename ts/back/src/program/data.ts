/**
 * Данные в программе (`platform/evaluator.md`, «Базовые объекты»):
 * коллекция и запись — данные отбора 162 (`objects`), к которым программа
 * добавляет перечисление блоком; результат команды — те же данные со
 * своим видом по умолчанию и форматами команды.
 */

import {
  type Data,
  dataOf,
  keywordSent,
  type Named,
  selectionMessages,
  unarySent,
} from "../objects/mod.ts";
import { type Answer, type Operand, type Value } from "./protocol.ts";
import {
  done,
  type Enumerable,
  enumeration,
  NIL,
  NO_OPERAND,
  notBlock,
  notCondition,
  notScalar,
  Num,
  Printed,
  Printing,
  Protocol,
  Text,
  truth,
} from "./objects.ts";

/**
 * Результат команды глазами программы: всё, что о нём знает команда, —
 * без исполнения.
 */
export interface CommandView {
  /** Данные для отбора: коллекция с видом команды или данные JSON. */
  data(): Data;
  /** Имена форматов результата, `json` в их числе. */
  formats(): readonly string[];
  /** Текст результата в формате `name` из `formats()`. */
  format(name: string): string;
}

/** Ключи ключевого селектора по порядку строки: `where:is:` → `where`, `is`. */
function keysOf(selector: string): string[] {
  return selector.slice(0, -1).split(":");
}

/**
 * Сообщение данным 162: их селектор — ключи по алфавиту, значения —
 * текстом, как в строке.
 */
function named(selector: string, args: readonly Value[]): Named {
  if (!selector.endsWith(":")) return unarySent(selector);
  const keys = keysOf(selector);
  return keywordSent(
    Object.fromEntries(keys.map((key, i) => [key, args[i].spelled(key)])),
  );
}

/** Селектор данных 162 для ключей по порядку строки. */
function dataSelector(keys: readonly string[]): string {
  return [...keys].sort().map((key) => `${key}:`).join("");
}

/** Сколько первых ключей понимают данные 162 одним сообщением. */
function dataTake(data: Data, keys: readonly string[]): number {
  for (let n = keys.length; n > 0; n--) {
    if (data.understands(dataSelector(keys.slice(0, n)))) return n;
  }
  return 0;
}

/** Понимают ли данные сообщение программы `selector`. */
function understood(data: Data, selector: string): boolean {
  if (!selector.endsWith(":")) return data.understands(selector);
  return data.understands(dataSelector(keysOf(selector)));
}

/**
 * Значение программы из данных (граница JSON): `null` — `nil`, список —
 * коллекция, объект — запись, число, булево, прочее — текст.
 *
 * @param data данные отбора, как их отдал результат
 */
export function fromData(data: Data): Value {
  const json = data.data();
  if (json === null || json === undefined) return NIL;
  if (Array.isArray(json)) {
    return new Items(data, json.map((item) => fromData(dataOf(item))));
  }
  if (typeof json === "object") {
    return new Fields(data, Object.values(json));
  }
  if (typeof json === "number") return new Num(json);
  if (typeof json === "boolean") return truth(json);
  return new Text(String(json));
}

const ITEMS: Protocol<Items> = new Protocol<Items>(
  "коллекция",
  enumeration<Items>(),
);

/** Сообщения отбора 162 — для ближайших к непонятому. */
function selections(): string[] {
  return selectionMessages().map((line) => line.selector);
}

/** Коллекция данных: отбор 162 и перечисление блоком. */
class Items implements Enumerable {
  readonly #data: Data;
  readonly #items: readonly Value[];

  constructor(data: Data, items: readonly Value[]) {
    this.#data = data;
    this.#items = items;
  }

  elements(): readonly Value[] {
    return this.#items;
  }

  take(keys: readonly string[]): number {
    return Math.max(ITEMS.take(keys), dataTake(this.#data, keys));
  }

  send(selector: string, args: readonly Value[]): Answer {
    if (ITEMS.understands(selector)) return ITEMS.send(this, selector, args);
    if (!understood(this.#data, selector)) {
      throw ITEMS.refusal(selector, selections());
    }
    return done(fromData(this.#data.reply(named(selector, args))));
  }

  shown(): string {
    return this.#data.text();
  }

  line(): string {
    return this.#data.line();
  }

  spelled(key: string): string {
    throw notScalar(key, "список");
  }

  operand(): Operand {
    return NO_OPERAND;
  }

  evaluated(args: readonly Value[]): Answer {
    return notBlock(ITEMS, args);
  }

  condition(by: string): boolean {
    return notCondition(by);
  }

  json(): unknown {
    return this.#data.data();
  }
}

const FIELDS: Protocol<Fields> = new Protocol<Fields>("запись", {});

/** Запись данных: поля унарными и `pick:` (162). */
class Fields implements Value {
  readonly #data: Data;
  readonly #values: readonly unknown[];

  /** @param values значения полей — для значения ключа из одного поля */
  constructor(data: Data, values: readonly unknown[]) {
    this.#data = data;
    this.#values = values;
  }

  take(keys: readonly string[]): number {
    return Math.max(FIELDS.take(keys), dataTake(this.#data, keys));
  }

  /** Общее сообщение — общим; прочее — поле: нет поля — отказ записи. */
  send(selector: string, args: readonly Value[]): Answer {
    if (FIELDS.understands(selector)) {
      return FIELDS.send(this, selector, args);
    }
    return done(fromData(this.#data.reply(named(selector, args))));
  }

  shown(): string {
    return this.#data.text();
  }

  line(): string {
    return this.#data.line();
  }

  /** Запись ровно с одним полем-скаляром — это поле (161). */
  spelled(key: string): string {
    if (this.#values.length !== 1) throw notScalar(key, "запись");
    return fromData(dataOf(this.#values[0])).spelled(key);
  }

  operand(): Operand {
    return NO_OPERAND;
  }

  evaluated(args: readonly Value[]): Answer {
    return notBlock(FIELDS, args);
  }

  condition(by: string): boolean {
    return notCondition(by);
  }

  json(): unknown {
    return this.#data.data();
  }
}

/**
 * Результат команды: сообщения — его данным, а печать и форматы — вид
 * команды (`platform/evaluator.md`, «Где исполняется»).
 */
export class CommandResult implements Value {
  readonly #view: CommandView;
  readonly #shown: string;
  readonly #data: Value;

  /** @param shown вид по умолчанию — как его напечатала строка ядра */
  constructor(view: CommandView, shown: string) {
    this.#view = view;
    this.#shown = shown;
    this.#data = fromData(view.data());
  }

  take(keys: readonly string[]): number {
    return this.#data.take(keys);
  }

  *send(selector: string, args: readonly Value[]): Answer {
    if (selector === PRINT) {
      yield new Printing(this.shown());
      return NIL;
    }
    if (this.#view.formats().includes(selector)) {
      return new Printed(this.#view.format(selector));
    }
    return yield* this.#data.send(selector, args);
  }

  shown(): string {
    return this.#shown;
  }

  line(): string {
    return this.#data.line();
  }

  spelled(key: string): string {
    return this.#data.spelled(key);
  }

  operand(): Operand {
    return this.#data.operand();
  }

  evaluated(args: readonly Value[], by: string): Answer {
    return this.#data.evaluated(args, by);
  }

  condition(by: string): boolean {
    return this.#data.condition(by);
  }

  json(): unknown {
    return this.#data.json();
  }
}

/** Печать у результата команды — её видом, а не видом данных. */
const PRINT = "print";

/** Образец результата команды до исполнения: пустая коллекция данных. */
const SAMPLE = new Items(dataOf([]), []);

/**
 * Результат команды до её исполнения (деление склеенного, проверка до
 * исполнения): что он поймёт, решает образец — коллекция данных.
 */
export const RESULT = {
  /** Сколько первых ключей результат поймёт одним сообщением. */
  take: (keys: readonly string[]): number => SAMPLE.take(keys),
  /** Отказ результата непонятому остатку с ближайшими. */
  refusal: (selector: string) => ITEMS.refusal(selector, selections()),
};
