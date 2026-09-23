/**
 * Просмотр слов программы вперёд (`platform/evaluator.md`, «Разбор»):
 * где кончается текст `^…^` и комментарий `rem … end`, чем закрыт `do` —
 * вид решает первый непарный закрыватель.
 */

import { GRAMMAR } from "../messages/mod.ts";
import { Refusal } from "../objects/mod.ts";
import { isParameter } from "./lexis.ts";
import { Misstep } from "./machine.ts";
import type { Names } from "./names.ts";
import {
  BlockLiteral,
  type Expression,
  Group,
  type Statements,
} from "./nodes.ts";

/**
 * Слова не складываются в программу: отказ с промежутком слов, о
 * которых он.
 */
export function unparsed(
  text: string,
  start: number,
  end: number,
  reason = text,
): Misstep {
  return new Misstep(new Refusal(text, { reason }), { start, end });
}

/** Текст `^…^` с позиции `at`: сам текст и позиция за ним. */
export function textAt(
  words: readonly string[],
  at: number,
  to: number,
): { readonly text: string; readonly next: number } {
  const first = words[at].slice(GRAMMAR.quote.length);
  if (first.endsWith(GRAMMAR.quote)) {
    return { text: first.slice(0, -GRAMMAR.quote.length), next: at + 1 };
  }
  const pieces = first === "" ? [] : [first];
  for (let i = at + 1; i < to; i++) {
    const word = words[i];
    if (word === GRAMMAR.literal && i + 1 < to) {
      pieces.push(words[++i]);
      continue;
    }
    if (!word.endsWith(GRAMMAR.quote)) {
      pieces.push(word);
      continue;
    }
    const last = word.slice(0, -GRAMMAR.quote.length);
    if (last !== "") pieces.push(last);
    return { text: pieces.join(" "), next: i + 1 };
  }
  throw unparsed("текст не закрыт", at, to);
}

/** Позиция за комментарием `rem … end` с позиции `at`; незакрытый — `to`. */
export function afterComment(
  words: readonly string[],
  at: number,
  to: number,
): number {
  const end = words.indexOf(GRAMMAR.close, at + 1);
  return end < 0 || end >= to ? to : end + 1;
}

/**
 * Закрыватель `do`: границы тела и то, что из него получается, — блок
 * или группа.
 */
export interface Closer {
  /** Начало тела — первое слово после `do` и параметров. */
  readonly body: number;
  /** Позиция закрывателя. */
  readonly end: number;
  /** Имена тела: у блока — с его параметрами. */
  names(outer: Names): Names;
  /** Узел из тела. */
  node(body: Statements): Expression;
  /**
   * Унарные слова за закрывателем на месте значения — сообщения этому
   * узлу (группа — первичное) или результату всего ключевого (блок).
   */
  takesUnaries(): boolean;
  /**
   * Место тела в тексте отказа: блок — `блок <by>`, группа — место
   * вокруг, `outer`.
   */
  label(by: string, outer: string): string;
}

/** Блок: `do :a … done` или `do … done`. */
class BlockClose implements Closer {
  readonly body: number;
  readonly end: number;
  readonly #params: readonly string[];

  constructor(params: readonly string[], body: number, end: number) {
    this.#params = params;
    this.body = body;
    this.end = end;
  }

  names(outer: Names): Names {
    return outer.inner(this.#params);
  }

  node(body: Statements): Expression {
    return new BlockLiteral(this.#params, body);
  }

  takesUnaries(): boolean {
    return false;
  }

  label(by: string): string {
    return by === "" ? "блок" : `блок ${by}`;
  }
}

/** Группа `do … end`: выражения в той же области. */
class GroupClose implements Closer {
  readonly body: number;
  readonly end: number;

  constructor(body: number, end: number) {
    this.body = body;
    this.end = end;
  }

  names(outer: Names): Names {
    return outer;
  }

  node(body: Statements): Expression {
    return new Group(body);
  }

  takesUnaries(): boolean {
    return true;
  }

  label(_by: string, outer: string): string {
    return outer;
  }
}

/**
 * Слово, которое пропускается при поиске закрывателя целиком: `--` со
 * своим словом, текст, комментарий, вложенный `do`. Иначе — `at`.
 */
function skipped(words: readonly string[], at: number, to: number): number {
  const word = words[at];
  if (word === GRAMMAR.literal) return Math.min(at + 2, to);
  if (word.startsWith(GRAMMAR.quote)) return textAt(words, at, to).next;
  if (word === GRAMMAR.comment) return afterComment(words, at, to);
  if (word === GRAMMAR.open) return closerOf(words, at, to).end + 1;
  return at;
}

/**
 * Закрыватель `do` с позиции `at`. С параметрами — блок до `done`, `end`
 * в его теле — закрытие выражения. Без параметров вид решает первый
 * непарный закрыватель: `done` — блок, `end` — группа.
 *
 * @throws Misstep — закрывателя нет
 */
export function closerOf(
  words: readonly string[],
  at: number,
  to: number,
): Closer {
  let body = at + 1;
  const params: string[] = [];
  while (body < to && isParameter(words[body])) {
    params.push(words[body].slice(GRAMMAR.parameter.length));
    body++;
  }
  const withParams = params.length > 0;
  let i = body;
  while (i < to) {
    const next = skipped(words, i, to);
    if (next !== i) {
      i = next;
      continue;
    }
    if (words[i] === GRAMMAR.blockEnd) return new BlockClose(params, body, i);
    if (words[i] === GRAMMAR.close && !withParams) {
      return new GroupClose(body, i);
    }
    i++;
  }
  throw unparsed(`${GRAMMAR.open} не закрыт`, at, to);
}
