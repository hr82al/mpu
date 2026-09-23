/**
 * Просмотр слов программы вперёд (`platform/evaluator.md`, «Разбор»):
 * где кончается текст `^…^` и комментарий `rem … end`, чем закрыт `do` —
 * вид решает первый непарный закрыватель.
 */

import { GRAMMAR } from "../messages/mod.ts";
import { Refusal, substituted } from "../objects/mod.ts";
import { isKey, isParameter } from "./lexis.ts";
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

/** Кусок текста из одного слова: что в текст и закрывает ли слово его. */
interface Piece {
  readonly text: string;
  readonly closes: boolean;
}

/** Сколько `^` подряд в конце слова. */
function trailing(word: string): number {
  let n = 0;
  while (n < word.length && word.at(-1 - n) === GRAMMAR.quote) n++;
  return n;
}

/**
 * Слово внутри текста: нечётный хвост `^` — последний закрывает, прочие
 * парами литералы; чётный — все парами литералы (`2^^` → `2^`).
 */
function tailOf(word: string): Piece {
  const n = trailing(word);
  return {
    text: word.slice(0, word.length - n) +
      GRAMMAR.quote.repeat(Math.floor(n / 2)),
    closes: n % 2 === 1,
  };
}

/**
 * Открывающее слово: первый `^` открывает, ведущие за ним — парами
 * литералы (`^^^_^^` — открыть и `^_^`), дальше — хвост. Слово из одних
 * `^` — хвост целиком: `^^` — пустой текст.
 */
function openerOf(word: string): Piece {
  const rest = word.slice(GRAMMAR.quote.length);
  const lead = rest.length - rest.replace(/^\^+/, "").length;
  if (lead === rest.length) return tailOf(rest);
  const tail = tailOf(rest.slice(lead));
  return {
    text: GRAMMAR.quote.repeat(Math.ceil(lead / 2)) + tail.text,
    closes: tail.closes,
  };
}

/**
 * Слово с пробельным символом (элемент MCP, кавычки оболочки) — текст
 * целиком: без крайних `^`, если оно ими обрамлено.
 */
function whole(word: string): string {
  const framed = word.length > 1 && word.startsWith(GRAMMAR.quote) &&
    word.endsWith(GRAMMAR.quote);
  return framed ? word.slice(1, -1) : word;
}

/** Слова, на которых поиск слова, закрывшего текст раньше, кончается. */
const SCAN_STOPS: ReadonlySet<string> = new Set([
  GRAMMAR.separator,
  GRAMMAR.open,
  GRAMMAR.close,
  GRAMMAR.blockEnd,
  GRAMMAR.comment,
]);

/**
 * Последнее слово с нечётным хвостом `^` за закрытием текста — до
 * следующего текста, ключа (его значение — чужое), конца выражения или
 * границы; нет — `-1`.
 */
function lateCloser(words: readonly string[], from: number, to: number) {
  let found = -1;
  for (let i = from; i < to; i++) {
    const word = words[i];
    if (SCAN_STOPS.has(word) || word.startsWith(GRAMMAR.quote)) break;
    if (isKey(word)) break;
    if (word === GRAMMAR.literal) i++;
    else if (trailing(word) % 2 === 1) found = i;
  }
  return found;
}

/** Строка `words`, где слово `at` заменено на `word`. */
function replaced(words: readonly string[], at: number, word: string) {
  return words.map((one, i) => i === at ? word : one);
}

/** Слово с удвоенным хвостом `^`: закрывающее становится литералом. */
export function doubled(word: string): string {
  return word + GRAMMAR.quote.repeat(trailing(word));
}

/** Отказ с готовой строкой: слово `at` заменено на `word`. */
function fixed(
  said: string,
  reason: string,
  words: readonly string[],
  at: number,
  word: string,
): Misstep {
  const line = replaced(words, at, word);
  return new Misstep(
    new Refusal(`${said} — mpu ${line.join(" ")}`, {
      reason,
      remedy: substituted([word]),
    }),
    { start: at, end: at + 1 },
  );
}

/** Текст закрылся на `closer`, а `late` дальше закрывать нечему. */
function closedEarly(
  words: readonly string[],
  closer: number,
  late: number,
): Misstep {
  const word = doubled(words[closer]);
  return fixed(
    `текст ^…^ закрылся раньше: слово «${words[closer]}» закрыло его, ` +
      `а «${words[late]}» дальше закрывать нечему. Если ^ — часть текста, ` +
      `удвой: ${word}`,
    "текст закрылся раньше",
    words,
    closer,
    word,
  );
}

/** Текст не закрыт до границы `to`. */
function unclosed(words: readonly string[], to: number): Misstep {
  return fixed(
    "текст не закрыт: добавь ^ к последнему слову",
    "текст не закрыт",
    words,
    to - 1,
    words[to - 1] + GRAMMAR.quote,
  );
}

/** Текст `^…^` с позиции `at`: сам текст и позиция за ним. */
export interface TextAt {
  readonly text: string;
  readonly next: number;
}

/**
 * Текст `^…^` с позиции `at` (`platform/at-word-literal.md`, правило 2):
 * `^` внутри — удвоением. Отказы — с готовой строкой.
 *
 * @throws Misstep — текст не закрыт или закрылся раньше
 */
export function textAt(
  words: readonly string[],
  at: number,
  to: number,
): TextAt {
  if (/\s/.test(words[at])) return { text: whole(words[at]), next: at + 1 };
  const pieces: string[] = [];
  for (let i = at; i < to; i++) {
    const piece = i === at ? openerOf(words[i]) : tailOf(words[i]);
    if (piece.text !== "") pieces.push(piece.text);
    if (!piece.closes) continue;
    const late = lateCloser(words, i + 1, to);
    if (late >= 0) throw closedEarly(words, i, late);
    return { text: pieces.join(" "), next: i + 1 };
  }
  throw unclosed(words, to);
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
  /**
   * Число параметров тела метода: у блока — его; группа телом метода не
   * бывает — `refused`.
   */
  params(refused: () => Error): number;
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

  params(): number {
    return this.#params.length;
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

  params(refused: () => Error): number {
    throw refused();
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
