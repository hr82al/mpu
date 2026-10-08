/**
 * Прежние формы строки (`platform/stage6-l1.md`, «Прежние формы и один
 * отказ»): строка `mpu` — одна команда, а несколько команд, переменные,
 * тексты и образ — не её слова. Строку с прежней формой не исполняет
 * ничто, ни частично: проверка одна, на входе строки, до маршрута, и
 * отказ один — код 2, найденное слово в тексте.
 */

import {
  atExecution,
  type HookReply,
  Undecided,
  unparsedLine,
} from "@mpu/cmd-claudehook";
import type { CommandIo } from "@mpu/command";
import type { OutputPolicy } from "@mpu/invokelog";
import { isBareLine, wordsOf } from "@mpu/language/frames";
import { GRAMMAR } from "@mpu/language/messages";
import { plainRefusal } from "@mpu/language/objects";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { commands } from "../registry/mod.ts";
import type { Speech } from "./printed.ts";

/** Вид отказа прежней форме. */
const NOT_COMMAND = "не команда mpu";

/** Как исправить строку: один совет на все прежние формы. */
const ADVICE =
  "одна строка — одна команда (путь → варианты → ключи → end → формат); " +
  "несколько команд — отдельными вызовами mpu или сценарием mpu-flow; " +
  "справка — mpu help";

/** Код отказа до исполнения: строку набрали не так. */
const MISWRITTEN = 2;

/**
 * Слова, которые прежняя форма на месте слова строки — вне `--`, группы
 * значения и значения ключа.
 */
const WHOLE: ReadonlySet<string> = new Set([".", ":=", "done", "rem"]);

/** Ключи образа: прежняя форма не первым словом (`forget:` первым — правила). */
const IMAGE_KEYS: ReadonlySet<string> = new Set(["define:", "forget:"]);

/** Число первым словом: `12`, `-3`, `2.5`. */
const NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * Первые слова прежних форм: строка образа и файл программы (`run:`
 * дальше в строке — ключ `mpu log`, не форма).
 */
const FIRST: ReadonlySet<string> = new Set(["image", "run:"]);

/** Край текста `^…^`: слово, которое им начинается или кончается. */
const QUOTE = "^";

/** Начало переменной `@x`. */
const VARIABLE = "@";

/** Начало параметра блока `:x`. */
const PARAMETER = ":";

/** Что строке нужно для отказа: ввод, вывод и запись журнала. */
export interface FormerLine {
  readonly io: Pick<CommandIo, "readStdin" | "stdinIsTerminal">;
  readonly speech: Speech;
  readonly journal: Pick<InvokeJournal, "nativeCall">;
}

/** Строка глазами проверки прежних форм. */
export interface Former {
  /** Прежняя форма — отказ и код 2, ничего не исполнено; иначе `run()`. */
  settle(line: FormerLine, run: () => Promise<number>): Promise<number>;
  /**
   * Ответ хука `PreToolUse`: у прежней формы — без решения (строка не
   * исполнится, отказ даст сама `mpu`); иначе — `probe()`.
   */
  consult(probe: () => Promise<HookReply>): Promise<HookReply>;
}

/** Прежней формы нет: строка идёт своим маршрутом. Null-объект модуля. */
const ADMITTED: Former = {
  settle: (_line, run) => run(),
  consult: (probe) => probe(),
};

/** Ответ хука прежней форме: причина — вид её отказа. */
const UNPARSED = new Undecided(unparsedLine(NOT_COMMAND));

/** Найдена прежняя форма `form`. */
class FormerForm implements Former {
  readonly #form: string;
  readonly #words: readonly string[];

  /** @param words слова строки — по ним маскируется запись журнала */
  constructor(form: string, words: readonly string[]) {
    this.#form = form;
    this.#words = words;
  }

  settle(line: FormerLine): Promise<number> {
    // Строка не исполнилась, но вызов был: запись журнала — с отказом.
    line.journal.nativeCall(policyOf(this.#words));
    const form = this.#form.includes(" ") ? `"${this.#form}"` : this.#form;
    plainRefusal(NOT_COMMAND, `mpu: ${form} — ${NOT_COMMAND}: ${ADVICE}`).tell(
      line.speech,
    );
    return Promise.resolve(MISWRITTEN);
  }

  consult(): Promise<HookReply> {
    return Promise.resolve(UNPARSED);
  }
}

/**
 * Строка без слов (или только `ask`): слова пришли бы вводом — это
 * прежняя форма `stdin`; ввода нет (терминал, пусто) — справка, как
 * прежде.
 */
class BareLine implements Former {
  async settle(line: FormerLine, run: () => Promise<number>): Promise<number> {
    if (line.io.stdinIsTerminal()) return await run();
    // BOM снимают слова, а не декодер.
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      await line.io.readStdin(),
    );
    if (wordsOf(text).length === 0) return await run();
    return await new FormerForm(GRAMMAR.stdin, []).settle(line);
  }

  /** Ввода хук не видит: что пришло бы им, выяснится при исполнении. */
  consult(): Promise<HookReply> {
    return atExecution();
  }
}

/**
 * Запись журнала строки с прежней формой: аргументы маскируются, если в
 * ней есть команда, которая свои не журналирует; секция out — так же.
 */
function policyOf(words: readonly string[]): OutputPolicy {
  const held = commands.filter((command) => holds(words, command.path));
  return {
    logsOutput: true,
    logsArguments: held.every((command) => command.logsArguments),
    logsStdout: held.every((command) => command.logsStdout),
    path: [],
  };
}

/** Есть ли в словах путь подряд. */
function holds(words: readonly string[], path: readonly string[]): boolean {
  return words.some((_, at) => path.every((part, i) => words[at + i] === part));
}

/**
 * Слово — ключ, который берёт следующее слово значением: `id:`. Слово на
 * `--` (флаг `--md`, `--x=v`, `--help`) значения не берёт.
 */
function isKey(word: string): boolean {
  return word.length > 1 && word.endsWith(":");
}

/** Параметр блока: `:x` сразу за `do`. */
function isParameter(word: string | undefined): boolean {
  return (
    word !== undefined &&
    word.length > 1 &&
    word.startsWith(PARAMETER) &&
    !WHOLE.has(word)
  );
}

/**
 * Где кончается группа значения, открытая `do` на месте `open`: её
 * парная `end` (с вложенными группами, слово за `--` — буквально); пары
 * нет — `-1`, и `do` — обычное слово.
 */
function closingOf(said: readonly string[], open: number): number {
  let depth = 0;
  for (let at = open; at < said.length; at++) {
    const word = said[at];
    if (word === GRAMMAR.literal) at++;
    else if (word === GRAMMAR.open) depth++;
    else if (word === GRAMMAR.close && --depth === 0) return at;
  }
  return -1;
}

/** Слово `word` на месте слова строки `at` — прежняя форма. */
function marks(word: string, at: number): boolean {
  if (WHOLE.has(word)) return true;
  if (word.startsWith(QUOTE) || word.endsWith(QUOTE)) return true;
  if (IMAGE_KEYS.has(word)) return at > 0;
  // Переменная — только на месте получателя: первым словом.
  return at === 0 && word.startsWith(VARIABLE);
}

/** Первая прежняя форма в словах строки; нет — `ADMITTED`. */
function formerIn(said: readonly string[]): Former {
  const first = said[0];
  if (first !== undefined && (NUMBER.test(first) || FIRST.has(first))) {
    return new FormerForm(first, said);
  }
  // Значение ключа идёт как есть; слово за `--` и группа ключом не бывают.
  let keyed = false;
  for (let at = 0; at < said.length; at++) {
    const word = said[at];
    const value = keyed;
    keyed = false;
    if (word === GRAMMAR.literal) {
      at++;
      continue;
    }
    if (word === GRAMMAR.open) {
      const next = said[at + 1];
      if (isParameter(next)) return new FormerForm(`${word} ${next}`, said);
      at = Math.max(at, closingOf(said, at));
      continue;
    }
    if (value) continue;
    if (marks(word, at)) return new FormerForm(word, said);
    keyed = isKey(word);
  }
  return ADMITTED;
}

/**
 * Проверка прежних форм строки: решена по словам, ещё ничего не читая
 * (ввод голой строки читает `settle`).
 *
 * @param argv слова вызова — голая ли строка
 * @param said слова строки без двери и без `--json`
 */
export function formerOf(
  argv: readonly string[],
  said: readonly string[],
): Former {
  if (isBareLine(argv)) return new BareLine();
  return formerIn(said);
}
