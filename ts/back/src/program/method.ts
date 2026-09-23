/**
 * Методы образа глазами программы (`platform/image.md`, «Вызов и
 * отражение»): вызов — согласие ядра и тело блоком со значениями.
 */

import { literalWords } from "../messages/mod.ts";
import { Refusal } from "../objects/mod.ts";
import { misstep, type Span } from "./machine.ts";
import { AS_VALUE, CoreLine, type Expression } from "./nodes.ts";
import type { Answer, Reach, Value } from "./protocol.ts";
import { Scope } from "./scope.ts";

/**
 * Метод образа на границе ядро → исполнитель: получатель, имя и слова
 * блока `do … done`.
 */
export interface MethodSource {
  readonly receiver: readonly string[];
  /** `cardsIn:`, `cardsIn:since:`, унарное `mine`. */
  readonly name: string;
  readonly source: readonly string[];
}

/**
 * Части имени ключами: `cardsIn:since:` → `cardsIn:`, `since:`; у
 * унарного — нет.
 */
export function nameParts(name: string): string[] {
  if (!name.includes(":")) return [];
  return name.split(":").filter((part) => part !== "").map((part) =>
    `${part}:`
  );
}

/** Слово, которым вызов метода начинается: первая часть или унарное имя. */
export function callWord(name: string): string {
  return nameParts(name)[0] ?? name;
}

/**
 * Тело метода глазами вызова: разбирается однажды на программу, когда
 * понадобится, — метод может звать сам себя.
 */
export interface MethodBody {
  /** Запись блока тела — вычисляется в собственной области. */
  literal(): Expression;
  /** Команды тела — собирателю, однажды на программу. */
  reach(into: Reach): void;
}

/**
 * Вызов метода образа: значения частей — объекты программы. Сначала
 * ядру уходит строка вызова (правило метода в момент отправки, вопрос
 * текстом со значениями, запись журнала), затем тело исполняется блоком.
 */
export class MethodCall implements Expression {
  readonly #path: readonly string[];
  readonly #name: string;
  readonly #args: readonly Expression[];
  readonly #body: MethodBody;
  readonly #span: Span;

  /**
   * @param path путь получателя
   * @param name имя метода
   * @param args значения частей имени по порядку
   * @param body тело метода
   * @param span слова вызова в строке
   */
  constructor(
    path: readonly string[],
    name: string,
    args: readonly Expression[],
    body: MethodBody,
    span: Span,
  ) {
    this.#path = path;
    this.#name = name;
    this.#args = args;
    this.#body = body;
    this.#span = span;
  }

  *evaluate(scope: Scope): Answer {
    const args: Value[] = [];
    for (const arg of this.#args) args.push(yield* arg.evaluate(scope));
    yield new CoreLine(this.#spoken(args), AS_VALUE);
    const block = yield* this.#body.literal().evaluate(new Scope());
    try {
      return yield* block.evaluated(args, this.#name);
    } catch (err) {
      throw misstep(err, this.#span);
    }
  }

  reach(into: Reach) {
    const links = [...this.#path, this.#name];
    into.command(links, links);
    for (const arg of this.#args) arg.reach(into);
    this.#body.reach(into);
  }

  /** Строка вызова ядру: части имени со значениями текстом. */
  #spoken(args: readonly Value[]): string[] {
    const parts = nameParts(this.#name);
    if (parts.length === 0) return [...this.#path, this.#name];
    return [
      ...this.#path,
      ...parts.flatMap((
        part,
        i,
      ) => [part, ...literalWords(textOf(args[i], part))]),
    ];
  }
}

/**
 * Значение текстом для строки вызова: скаляр — его текст; прочее — его
 * строчный вид (метод принимает и коллекцию, а вопрос называет её так,
 * как её печатает список).
 */
function textOf(value: Value, part: string): string {
  try {
    return value.spelled(part.slice(0, -1));
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    return value.line();
  }
}
