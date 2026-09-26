/**
 * Откуда строка взяла слова (`platform/program-input.md`): набраны словами
 * вызова, пришли вводом строки без слов или из файла `run:`. Источник сам
 * решает, каким путём идёт строка, как её называет отказ, свободен ли ввод
 * её командам и какие у программы параметры.
 */

import type { CommandIo } from "../command/mod.ts";
import { isBareLine, wordsOf } from "../frames/mod.ts";
import { ASK_WORD, GRAMMAR } from "../messages/mod.ts";
import { line as lineText, type Refused, ROOT_TEXT } from "../objects/mod.ts";
import {
  fileParams,
  type Naming,
  namingOf,
  NO_PARAMS,
  type Params,
  TYPED,
} from "../program/mod.ts";
import { type Doorless, type Entry, entryOf, needsDoor } from "./ahead.ts";
import type { Speech } from "./printed.ts";
import {
  programFile,
  type ProgramFiles,
  runHelp,
  SourceError,
} from "./runfile.ts";
import { BUSY_INPUT, type LineStdin, StdinOnce } from "./value.ts";

/** Источник слов строки. */
export interface Origin extends Doorless {
  /** Слова, которые исполняет строка (без двери). */
  readonly words: readonly string[];
  /** Как отказ программы называет источник. */
  readonly naming: Naming;
  /** Параметры программы (`run:`); у прочих — `NO_PARAMS`. */
  readonly params: Params;
  /** Ввод строки для её команд. */
  stdin(io: Pick<CommandIo, "readStdin" | "stdinIsTerminal">): LineStdin;
  /** Вход строки: набранный `typed` или дверь, объявленная текстом файла. */
  entry(typed: Entry): Entry;
  /**
   * Исполнение: у набранной строки путь решает её вид (`typed`), у
   * программы из ввода и файла — всегда путь программы (`program`);
   * справку и отказ источника источник говорит в `told` сам.
   */
  route(
    program: () => Promise<number>,
    typed: () => Promise<number>,
    told: Speech,
  ): Promise<number>;
}

/** Набранная строка: всё — как до программ из ввода. */
class TypedLine implements Origin {
  readonly words: readonly string[];
  readonly naming = TYPED;
  readonly params = NO_PARAMS;

  constructor(words: readonly string[]) {
    this.words = words;
  }

  needsDoor(path: readonly string[]): Refused {
    return needsDoor(lineText(ROOT_TEXT, this.words), this.words, path);
  }

  stdin(io: Pick<CommandIo, "readStdin" | "stdinIsTerminal">): LineStdin {
    return new StdinOnce(io);
  }

  entry(typed: Entry): Entry {
    return typed;
  }

  route(
    _program: () => Promise<number>,
    typed: () => Promise<number>,
  ): Promise<number> {
    return typed();
  }
}

/**
 * Программа из ввода: даже одна команда — программа (образа и
 * синхронизации ввод не несёт), отказ называет источник `stdin`, ввод
 * командам не достаётся — его уже прочитала программа.
 */
class StdinProgram implements Origin {
  readonly words: readonly string[];
  readonly naming = namingOf(GRAMMAR.stdin);
  readonly params = NO_PARAMS;

  constructor(words: readonly string[]) {
    this.words = words;
  }

  needsDoor(path: readonly string[]): Refused {
    // Набранных слов нет: подсказка — одна дверь (`mpu ask`).
    return needsDoor(GRAMMAR.stdin, [], path);
  }

  stdin(): LineStdin {
    return BUSY_INPUT;
  }

  entry(typed: Entry): Entry {
    return typed;
  }

  route(program: () => Promise<number>): Promise<number> {
    return program();
  }
}

/**
 * Программа из файла `run:`: отказ называет набранную строку без
 * подсказки, ввод строки свободен (его мог взять ключ `stdin`), начальный
 * `ask` текста — дверь всей строки.
 */
class FileProgram implements Origin {
  readonly words: readonly string[];
  readonly naming: Naming;
  readonly params: Params;
  readonly #source: string;
  readonly #said: readonly string[];
  readonly #door: boolean;
  readonly #stdin: LineStdin;

  constructor(parts: {
    words: readonly string[];
    source: string;
    said: readonly string[];
    door: boolean;
    params: ReadonlyMap<string, string>;
    stdin: LineStdin;
  }) {
    this.words = parts.words;
    this.naming = namingOf(parts.source);
    this.params = fileParams(parts.source, parts.params);
    this.#source = parts.source;
    this.#said = parts.said;
    this.#door = parts.door;
    this.#stdin = parts.stdin;
  }

  needsDoor(path: readonly string[]): Refused {
    return needsDoor(this.#source, this.#said, path);
  }

  stdin(): LineStdin {
    return this.#stdin;
  }

  entry(typed: Entry): Entry {
    return this.#door ? entryOf([ASK_WORD]) : typed;
  }

  route(program: () => Promise<number>): Promise<number> {
    return program();
  }
}

/**
 * Строка, которую источник кончает сам, не исполняя: справка `run: help`
 * или отказ пути. Прочее — как у набранной строки.
 */
class Answered implements Origin {
  readonly words: readonly string[];
  readonly naming = TYPED;
  readonly #typed: TypedLine;
  readonly #answer: (told: Speech) => number;

  constructor(typed: TypedLine, answer: (told: Speech) => number) {
    this.words = typed.words;
    this.#typed = typed;
    this.#answer = answer;
  }

  readonly params = NO_PARAMS;

  needsDoor(path: readonly string[]): Refused {
    return this.#typed.needsDoor(path);
  }

  stdin(io: Pick<CommandIo, "readStdin" | "stdinIsTerminal">): LineStdin {
    return this.#typed.stdin(io);
  }

  entry(typed: Entry): Entry {
    return typed;
  }

  route(
    _program: () => Promise<number>,
    _typed: () => Promise<number>,
    told: Speech,
  ): Promise<number> {
    return Promise.resolve(this.#answer(told));
  }
}

/** Код отказа до исполнения. */
const REFUSED = 2;

/**
 * Источник строки `run: …`: `help` значением — справка; иначе файл,
 * прочитанный и проверенный, либо отказ источника.
 *
 * @param typed набранные слова с дверью — имя источника в отказе
 * @param said они же без двери: `run:`, путь, ключи
 */
async function runOrigin(
  typed: readonly string[],
  said: readonly string[],
  io: Pick<CommandIo, "readStdin" | "stdinIsTerminal" | "cwd">,
  files: ProgramFiles,
): Promise<Origin> {
  const line = new TypedLine(said);
  if (said[1] === "help" && said.length === 2) {
    return new Answered(line, (told) => {
      told.stdout(runHelp());
      return 0;
    });
  }
  const source = lineText(ROOT_TEXT, typed);
  const stdin = new StdinOnce(io);
  try {
    const file = await programFile(said, io.cwd(), files, stdin);
    return new FileProgram({ ...file, source, said, stdin });
  } catch (err) {
    if (!(err instanceof SourceError)) throw err;
    const refused = err.refused(source);
    return new Answered(line, (told) => {
      refused.tell(told);
      return REFUSED;
    });
  }
}

/** Набранная строка `words` — источник для тех, кто строит её сам. */
export function typedLine(words: readonly string[]): Origin {
  return new TypedLine(words);
}

/**
 * Источник строки: `run:` первым словом со значением — файл; без слов
 * (или только `ask`) при вводе из пайпа — программа из ввода, ввод
 * читается сразу; пустой ввод — набранная строка без слов, то есть
 * справка, как прежде.
 *
 * @param argv слова вызова
 * @param walked слова строки без `--json` — с дверью
 * @param door сколько слов двери в начале `walked`
 * @param io ввод вызова, терминал ли он и каталог строки
 * @param files файлы программ и каталоги, которых программа не читает
 */
export async function originOf(
  argv: readonly string[],
  walked: readonly string[],
  door: number,
  io: Pick<CommandIo, "readStdin" | "stdinIsTerminal" | "cwd">,
  files: ProgramFiles,
): Promise<Origin> {
  const said = walked.slice(door);
  // `mpu run:` без значения — набранная строка: отказ ключа скажет корень.
  if (said[0] === GRAMMAR.run && said.length > 1) {
    return await runOrigin(walked, said, io, files);
  }
  if (!isBareLine(argv) || io.stdinIsTerminal()) return new TypedLine(said);
  // Ввод пришёл строкой кадра — UTF-8 верен по построению (неверный
  // отвергает клиент); BOM снимают слова, а не декодер.
  const text = new TextDecoder("utf-8", { ignoreBOM: true })
    .decode(await io.readStdin());
  const words = wordsOf(text);
  if (words.length === 0) return new TypedLine(said);
  return new StdinProgram(words);
}
