/**
 * Решение правила и изменение правила (`platform/policy.md`). Каждое
 * решение само исполняет свой исход; строка `allow|ask|deny` существует
 * только на границе файла и данных `policy` — `verdictNamed` и `word`.
 */

import type { Channel } from "./channel.ts";
import type { RulePath } from "./path.ts";

/** Строка, которую решают правила. */
export interface Execution<T> {
  /** Текст пути строки (`mpu kiten ls`) для вопроса и отказов. */
  readonly text: string;
  run(): Promise<T>;
  /** Отказ с готовым текстом. */
  refuse(reason: string): Promise<T>;
}

/** Правило, как его показывает `policy` и отдают сообщения изменения. */
export interface RuleEntry {
  readonly path: string;
  /** `null` — правила на пути больше нет (`forget:`). */
  readonly verdict: string | null;
}

/** Куда изменение записывает правило. */
export interface RuleWriter {
  set(path: RulePath, verdict: Verdict): void;
  forget(path: RulePath): void;
}

/**
 * Пишущие подкоманды, которые правило на пути откроет без своего
 * правила; нет таких — пусто.
 */
export type Writers = (path: RulePath) => readonly string[];

/** Сообщение корню, меняющее правило: `allow:`, `ask:`, `deny:`, `forget:`. */
export interface Change {
  /** Ключ сообщения и слово после стрелки в вопросе. */
  readonly word: string;
  question(path: RulePath, writers: Writers): string;
  apply(book: RuleWriter, path: RulePath): RuleEntry;
}

/** Исход решения: каждый исполняет себя сам. */
interface Outcome {
  settle<T>(
    execution: Execution<T>,
    channel: Channel,
    won: string,
  ): Promise<T>;
}

/** Что решение добавляет после стрелки в вопросе об изменении правила. */
interface Caveat {
  after(word: string, path: RulePath, writers: Writers): string;
}

/** Решение правила: исход и изменение правила этим решением. */
export class Verdict implements Change {
  readonly word: string;
  readonly #outcome: Outcome;
  readonly #caveat: Caveat;

  constructor(word: string, outcome: Outcome, caveat: Caveat) {
    this.word = word;
    this.#outcome = outcome;
    this.#caveat = caveat;
  }

  /**
   * Исполняет исход решения.
   *
   * @param execution строка под решением
   * @param channel у кого спросить
   * @param won путь выигравшего правила текстом
   */
  settle<T>(
    execution: Execution<T>,
    channel: Channel,
    won: string,
  ): Promise<T> {
    return this.#outcome.settle(execution, channel, won);
  }

  question(path: RulePath, writers: Writers): string {
    return changeQuestion(path, this.#caveat.after(this.word, path, writers));
  }

  apply(book: RuleWriter, path: RulePath): RuleEntry {
    book.set(path, this);
    return { path: path.text(), verdict: this.word };
  }
}

function changeQuestion(path: RulePath, after: string): string {
  return `изменить правило: ${path.text()} → ${after}? [y/N] `;
}

/** После стрелки — только слово решения. */
const PLAIN: Caveat = { after: (word) => word };

/** Правило на группе открывает и её пишущие подкоманды — вопрос их называет. */
const OPENS_WRITERS: Caveat = {
  after(word, path, writers) {
    const names = writers(path);
    if (names.length === 0) return word;
    return `${word} (группа: подкоманды с записью — ${names.join(", ")})`;
  },
};

const RUN: Outcome = {
  settle: (execution) => execution.run(),
};

const QUESTION: Outcome = {
  settle(execution, channel) {
    const text = execution.text;
    return channel.ask(`выполнить ${text}? [y/N] `, {
      yes: () => execution.run(),
      no: () => execution.refuse(`${text}: не подтверждено`),
      absent: () =>
        execution.refuse(`${text}: нужно подтверждение, а спросить некого`),
    });
  },
};

const REFUSAL: Outcome = {
  settle: (execution, _channel, won) =>
    execution.refuse(`${execution.text}: запрещено правилом «${won}»`),
};

export const ALLOW: Verdict = new Verdict("allow", RUN, OPENS_WRITERS);
export const ASK: Verdict = new Verdict("ask", QUESTION, PLAIN);
export const DENY: Verdict = new Verdict("deny", REFUSAL, PLAIN);

/** Правило удаляется: путь снова наследует. */
export const FORGET: Change = {
  word: "forget",
  question: (path) => changeQuestion(path, "forget"),
  apply(book, path) {
    book.forget(path);
    return { path: path.text(), verdict: null };
  },
};

const BY_WORD: ReadonlyMap<string, Verdict> = new Map(
  [ALLOW, ASK, DENY].map((verdict) => [verdict.word, verdict]),
);

/** Слово решения в строке файла не из трёх. */
export class UnknownVerdict extends Error {
  override name = "UnknownVerdict";
}

/**
 * Решение по слову из файла правил (граница хранения).
 *
 * @throws UnknownVerdict — слово не `allow`, `ask` или `deny`
 */
export function verdictNamed(word: string): Verdict {
  const verdict = BY_WORD.get(word);
  if (verdict === undefined) {
    throw new UnknownVerdict(`неизвестное решение ${JSON.stringify(word)}`);
  }
  return verdict;
}
