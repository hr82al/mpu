/**
 * Откуда строка взяла слова (`platform/program-input.md`): набраны словами
 * вызова или пришли вводом строки без слов. Источник сам решает, каким
 * путём идёт строка, как её называет отказ и свободен ли ввод её командам.
 */

import type { CommandIo } from "../command/mod.ts";
import { isBareLine, wordsOf } from "../frames/mod.ts";
import { GRAMMAR } from "../messages/mod.ts";
import { line as lineText, type Refused, ROOT_TEXT } from "../objects/mod.ts";
import { type Naming, namingOf, TYPED } from "../program/mod.ts";
import { type Doorless, needsDoor } from "./ahead.ts";
import { BUSY_INPUT, type LineStdin, StdinOnce } from "./value.ts";

/** Источник слов строки. */
export interface Origin extends Doorless {
  /** Слова, которые исполняет строка (без двери). */
  readonly words: readonly string[];
  /** Как отказ программы называет источник. */
  readonly naming: Naming;
  /** Ввод строки для её команд. */
  stdin(io: Pick<CommandIo, "readStdin" | "stdinIsTerminal">): LineStdin;
  /**
   * Исполнение: у набранной строки путь решает её вид (`typed`), у
   * программы из ввода — всегда путь программы (`program`).
   */
  route(
    program: () => Promise<number>,
    typed: () => Promise<number>,
  ): Promise<number>;
}

/** Набранная строка: всё — как до программ из ввода. */
class TypedLine implements Origin {
  readonly words: readonly string[];
  readonly naming = TYPED;

  constructor(words: readonly string[]) {
    this.words = words;
  }

  needsDoor(path: readonly string[]): Refused {
    return needsDoor(lineText(ROOT_TEXT, this.words), this.words, path);
  }

  stdin(io: Pick<CommandIo, "readStdin" | "stdinIsTerminal">): LineStdin {
    return new StdinOnce(io);
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

  route(program: () => Promise<number>): Promise<number> {
    return program();
  }
}

/** Набранная строка `words` — источник для тех, кто строит её сам. */
export function typedLine(words: readonly string[]): Origin {
  return new TypedLine(words);
}

/**
 * Источник строки: без слов (или только `ask`) при вводе из пайпа —
 * программа из ввода, ввод читается сразу; пустой ввод — набранная
 * строка без слов, то есть справка, как прежде.
 *
 * @param argv слова вызова
 * @param said набранные слова без двери
 * @param io ввод вызова и терминал ли он
 */
export async function originOf(
  argv: readonly string[],
  said: readonly string[],
  io: Pick<CommandIo, "readStdin" | "stdinIsTerminal">,
): Promise<Origin> {
  if (!isBareLine(argv) || io.stdinIsTerminal()) return new TypedLine(said);
  // Ввод пришёл строкой кадра — UTF-8 верен по построению (неверный
  // отвергает клиент); BOM снимают слова, а не декодер.
  const text = new TextDecoder("utf-8", { ignoreBOM: true })
    .decode(await io.readStdin());
  const words = wordsOf(text);
  if (words.length === 0) return new TypedLine(said);
  return new StdinProgram(words);
}
