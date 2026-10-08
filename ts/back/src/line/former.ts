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
import type { Command, CommandIo } from "@mpu/command";
import type { OutputPolicy } from "@mpu/invokelog";
import { isBareLine, wordsOf } from "@mpu/language/frames";
import { GRAMMAR } from "@mpu/language/messages";
import { plainRefusal } from "@mpu/language/objects";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { commands, findCommand } from "../registry/mod.ts";
import { addressesOf, textKeysOf } from "./keyed.ts";
import type { Speech } from "./printed.ts";
import { formatsOf } from "./tree.ts";

/** Вид отказа прежней форме. */
const NOT_COMMAND = "не команда mpu";

/** Как исправить строку: один совет на все прежние формы. */
const ADVICE =
  "одна строка — одна команда (путь → варианты → ключи → end → формат); " +
  "несколько команд — отдельными вызовами mpu или сценарием mpu-flow; " +
  "справка — mpu help";

/** Код отказа до исполнения: строку набрали не так. */
const MISWRITTEN = 2;

/** Слова, которые прежняя форма где угодно, кроме мест «как есть». */
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

/** Начало текста `^…^`. */
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

/** Ключи листа, которым начата строка: чьё значение берётся как есть. */
interface LeafKeys {
  /** Значение `value` ключа `key` — слово как есть, не прежняя форма. */
  asIs(key: string | undefined, value: string): boolean;
  /** `@путь` у ключа `key` — файл, его подсказку даёт ключ (`keys.ts`). */
  readsFile(key: string | undefined): boolean;
}

/** Строка не начата листом: мест «как есть» нет. */
const NO_LEAF: LeafKeys = {
  asIs: () => false,
  readsFile: () => false,
};

/** Ключи листа реестра. */
class Leaf implements LeafKeys {
  readonly #texts: ReadonlySet<string>;
  readonly #files: ReadonlySet<string>;

  constructor(command: Command) {
    const formats = Object.keys(formatsOf(command.path));
    this.#texts = new Set(textKeysOf(command, formats));
    const addresses = addressesOf(command, formats);
    this.#files = new Set(
      Object.keys(command.fromFile).map((input) =>
        fileKeyOf(addresses.get(input), input),
      ),
    );
  }

  /**
   * Ключ-текст берёт слово как есть (`platform/at-word-literal.md`,
   * правило 1); `^…` и `do` там — свои.
   */
  asIs(key: string | undefined, value: string): boolean {
    if (key === undefined || !this.#texts.has(keyName(key))) return false;
    return !value.startsWith(QUOTE);
  }

  readsFile(key: string | undefined): boolean {
    return key !== undefined && this.#files.has(keyName(key));
  }
}

/**
 * Имя ключа входа `input`, чей файл читается своим ключом: из адреса
 * `body:`; вход без адреса-ключа — его имя.
 */
function fileKeyOf(address: string | undefined, input: string): string {
  if (address === undefined || !address.endsWith(":")) return input;
  return address.slice(0, -1);
}

/** Имя ключа по слову-ключу (`isKey`): `text:` и `--text` → `text`. */
function keyName(key: string): string {
  return key.endsWith(":") ? key.slice(0, -1) : key.slice(2);
}

/** Лист реестра, которым начата строка; не начата — `NO_LEAF`. */
function leafOf(said: readonly string[]): LeafKeys {
  for (let end = said.length; end > 0; end--) {
    const command = findCommand(said.slice(0, end));
    if (command !== undefined) return new Leaf(command);
  }
  return NO_LEAF;
}

/** Слово — ключ: `id:` или `--id` (сам `--` — знак литерала). */
function isKey(word: string): boolean {
  if (word.endsWith(":")) return word.length > 1;
  return word.startsWith("--") && word.length > 2;
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

/**
 * Слово `word` на месте `at` — прежняя форма; `key` — ключ, чьё значение
 * это слово (нет — `undefined`).
 */
function marks(
  word: string,
  at: number,
  key: string | undefined,
  leaf: LeafKeys,
): boolean {
  if (WHOLE.has(word) || word.startsWith(QUOTE)) return true;
  if (IMAGE_KEYS.has(word)) return at > 0;
  if (!word.startsWith(VARIABLE)) return false;
  // Переменная — на месте получателя или значения ключа; `@путь` у
  // ключа файла — его подсказка, не язык.
  return at === 0 || (key !== undefined && !leaf.readsFile(key));
}

/** Первая прежняя форма в словах строки; нет — `ADMITTED`. */
function formerIn(said: readonly string[]): Former {
  const first = said[0];
  if (first !== undefined && (NUMBER.test(first) || FIRST.has(first))) {
    return new FormerForm(first, said);
  }
  const leaf = leafOf(said);
  // Ключ, чьё значение — следующее слово; слово за `--` и группа ключом
  // не бывают.
  let key: string | undefined;
  for (let at = 0; at < said.length; at++) {
    const word = said[at];
    const valueOf = key;
    key = undefined;
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
    if (leaf.asIs(valueOf, word)) continue;
    if (marks(word, at, valueOf, leaf)) return new FormerForm(word, said);
    if (isKey(word)) key = word;
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
