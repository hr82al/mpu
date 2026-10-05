/**
 * Разбор Bash-строки хука (`claude-hook-pre-tool-use.md`, «Разбор
 * Bash-строки» [D.4]): принимается ровно одна простая команда `mpu` с
 * литеральными словами. Один проход слева направо, первое событие
 * решает; конец первого слова — тоже событие. Это граница ввода, поэтому
 * класс символа выбирается `switch`.
 */

import { type HookReply, NOT_MPU, Undecided } from "./reply.ts";
import type { Consult, ToolCall } from "./tool.ts";

/** Причина: подстановка оболочки — что исполнится, не видно. */
export const SUBSTITUTION = "оболочка: подстановка";
/** Причина: раскрытие шаблона — слова станут другими. */
export const EXPANSION = "оболочка: раскрытие";
/** Причина: оператор, комментарий или вторая строка. */
export const COMPOUND = "оболочка: не одна простая команда";
/** Причина: кавычка не закрыта к концу строки. */
export const UNCLOSED = "оболочка: незакрытая кавычка";

/** Первое слово строки, которое хук принимает. */
const MPU = "mpu";

/**
 * Событие прохода: строка — не одна простая команда `mpu`, текст —
 * причина. Прерывает проход изнутри и наружу `shellCall` не выходит.
 */
class ShellEvent extends Error {
  override name = "ShellEvent";
}

/** Слова одной простой команды `mpu` — решающему, без самого `mpu`. */
class ShellWords implements ToolCall {
  readonly #words: readonly string[];

  constructor(words: readonly string[]) {
    this.#words = words;
  }

  reply(consult: Consult): Promise<HookReply> {
    return consult(this.#words.slice(1));
  }
}

/** Событие разбора: ответ без решения с его причиной. */
class Eventful implements ToolCall {
  readonly #reason: string;

  constructor(reason: string) {
    this.#reason = reason;
  }

  reply(): Promise<HookReply> {
    return Promise.resolve(new Undecided(this.#reason));
  }
}

/** Остаток строки — только пробелы и переводы: перевод строки в хвосте. */
const TAIL = /^[ \t\n]*$/;

/** Проход по строке: слова копятся, событие бросается сразу. */
class Scan {
  readonly #text: string;
  #at = 0;
  readonly #words: string[] = [];
  #word = "";
  /** Слово начато: буквой или кавычками (`''` — пустое слово). */
  #open = false;

  constructor(text: string) {
    this.#text = text;
  }

  words(): readonly string[] {
    while (this.#at < this.#text.length) this.#outside(this.#next());
    this.#end();
    // Пустая строка и одни пробелы: первого слова нет — и `mpu` нет.
    if (this.#words.length === 0) throw new ShellEvent(NOT_MPU);
    return this.#words;
  }

  #next(): string {
    return this.#text[this.#at++];
  }

  #outside(char: string) {
    switch (char) {
      case " ":
      case "\t":
        return this.#end();
      case "\n":
        return this.#newline();
      case ";":
      case "&":
      case "|":
      case "<":
      case ">":
      case "(":
      case ")":
        throw new ShellEvent(COMPOUND);
      case "$":
      case "`":
        throw new ShellEvent(SUBSTITUTION);
      case "*":
      case "?":
      case "[":
      case "{":
      case "~":
        throw new ShellEvent(EXPANSION);
      case "#":
        if (!this.#open) throw new ShellEvent(COMPOUND);
        return this.#letter(char);
      case "\\":
        return this.#escaped();
      case "'":
        return this.#single();
      case '"':
        return this.#double();
      default:
        return this.#letter(char);
    }
  }

  #letter(text: string) {
    this.#word += text;
    this.#open = true;
  }

  /** Слово кончилось; первое — обязано быть `mpu`. */
  #end() {
    if (!this.#open) return;
    this.#words.push(this.#word);
    this.#word = "";
    this.#open = false;
    if (this.#words.length === 1 && this.#words[0] !== MPU) {
      throw new ShellEvent(NOT_MPU);
    }
  }

  /** Перевод строки в хвосте — разделитель, иначе — вторая команда. */
  #newline() {
    if (!TAIL.test(this.#text.slice(this.#at))) {
      throw new ShellEvent(COMPOUND);
    }
    this.#at = this.#text.length;
    this.#end();
  }

  /** `\` вне кавычек: символ буквально, перевод строки — продолжение. */
  #escaped() {
    if (this.#at >= this.#text.length) return this.#letter("\\");
    const char = this.#next();
    if (char !== "\n") this.#letter(char);
  }

  /** `'…'`: всё буквально до следующей `'`. */
  #single() {
    const close = this.#text.indexOf("'", this.#at);
    if (close < 0) throw new ShellEvent(UNCLOSED);
    this.#letter(this.#text.slice(this.#at, close));
    this.#at = close + 1;
  }

  /** `"…"`: подстановка — событие, `\` экранирует только пять символов. */
  #double() {
    this.#letter("");
    while (this.#at < this.#text.length) {
      const char = this.#next();
      switch (char) {
        case '"':
          return;
        case "$":
        case "`":
          throw new ShellEvent(SUBSTITUTION);
        case "\\":
          this.#quotedEscape();
          break;
        default:
          this.#letter(char);
      }
    }
    throw new ShellEvent(UNCLOSED);
  }

  /** `\` в `"…"`: перед `$ \` " \` — снимается, перед прочими — буква. */
  #quotedEscape() {
    const char = this.#text[this.#at];
    if (char === "\n") {
      this.#at++;
      return;
    }
    if (char === "$" || char === "`" || char === '"' || char === "\\") {
      this.#at++;
      return this.#letter(char);
    }
    this.#letter("\\");
  }
}

/**
 * Вызов из Bash-строки: слова одной простой команды `mpu` либо, если
 * строка не такая (оператор, подстановка, раскрытие, незакрытая кавычка,
 * первого слова нет или оно не `mpu`), — ответ без решения с причиной.
 *
 * @param command текст `tool_input.command`
 */
export function shellCall(command: string): ToolCall {
  try {
    return new ShellWords(new Scan(command).words());
  } catch (err) {
    if (!(err instanceof ShellEvent)) throw err;
    return new Eventful(err.message);
  }
}
