/**
 * Что есть у любого объекта (`help`, `selectors`, `respondsTo:`) и вид
 * результата «данные» с его объектом-значением. Одно место на все виды.
 */

import { Description, keyword, type Method, unary } from "./method.ts";
import { dataHelp, ended } from "./result.ts";
import { NO_REMEDY } from "./remedy.ts";
import type {
  Call,
  Doc,
  Outcome,
  Receiver,
  Report,
  Sent,
  Yields,
} from "./protocol.ts";
import { HELP_SELECTOR } from "./protocol.ts";

/** Данные в конце цепочки: любое сообщение к ним — отказ. */
class Value implements Receiver {
  readonly #data: unknown;

  constructor(data: unknown) {
    this.#data = data;
  }

  lookup(sent: Sent): Call {
    return ended(this, sent);
  }

  final(report: Report): Promise<Outcome> {
    return Promise.resolve(report.value(this.#data));
  }
}

/** Вид результата «данные». */
export const DATA: Yields<unknown> = {
  parsing: () => withCommon(new Description()).build(),
  about: (path, doc) => dataHelp(path, doc),
  remedy: () => NO_REMEDY,
  receive: (data) => new Value(data),
};

/** Что объект знает о себе: его собственные селекторы. */
export interface Reflective {
  selectors(): string[];
  respondsTo(selector: string): boolean;
}

function about(purpose: string): Doc {
  return { purpose, help: `Справка: ${purpose}.` };
}

const REFLECTION: readonly Method<Reflective>[] = [
  unary(
    "selectors",
    about("собственные селекторы объекта"),
    DATA,
    (self) => self.selectors(),
  ),
  keyword(
    { respondsTo: "value" },
    ["respondsTo"],
    about("понимает ли объект селектор"),
    DATA,
    (self, args) => self.respondsTo(String(args.respondsTo)),
  ),
];

/** Общие методы по селектору. */
export const COMMON: ReadonlyMap<string, Method<Reflective>> = new Map(
  REFLECTION.map((method) => [method.selector, method]),
);

/** Общие селекторы, о которых отвечает `respondsTo:`. */
export const COMMON_SELECTORS: ReadonlySet<string> = new Set([
  HELP_SELECTOR,
  ...COMMON.keys(),
]);

/** Добавляет общие селекторы в описание для разбора. */
export function withCommon(into: Description): Description {
  // `help` в словарь не входит: его убирает из строки режим справки.
  into.unary(HELP_SELECTOR);
  for (const method of REFLECTION) method.describe(into);
  return into;
}
