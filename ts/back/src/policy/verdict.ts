/**
 * Решение правила и изменение правила (`platform/policy.md`). Каждое
 * решение само исполняет свой исход; строка `allow|ask|deny` существует
 * только на границе файла и данных `policy` — `verdictNamed` и `word`.
 */

import type { Channel } from "./channel.ts";
import type { RulePath } from "./path.ts";

/** Вид отказа: человек ответил «нет». */
export const NOT_CONFIRMED = "не подтверждено";
/** Вид отказа: подтверждение нужно, а канала к человеку нет. */
export const NOBODY_TO_ASK = "нужно подтверждение, а спросить некого";
/** Вид отказа: запрет правилом. */
export const DENIED = "запрещено правилом";

/** Строка, которую решают правила. */
export interface Execution<T> {
  /** Текст пути строки (`mpu kiten ls`) для вопроса и отказов. */
  readonly text: string;
  run(): Promise<T>;
  /**
   * Отказ с готовым текстом.
   *
   * @param reason вид отказа — постоянная строка (`platform/refusal-object.md`)
   * @param text текст отказа целиком
   */
  refuse(reason: string, text: string): Promise<T>;
  /**
   * Строка пришла не по тому адресу: отказ с подсказкой верного. Какой
   * адрес верный, знает тот, кто собрал строку, а не правила.
   */
  redirect(): Promise<T>;
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

/** Исход решения по адресу строки: каждый исполняет себя сам. */
export interface Treatment {
  settle<T>(
    execution: Execution<T>,
    channel: Channel,
    won: string,
  ): Promise<T>;
  /** Исполняется ли строка по этому адресу: такую показывают в списках. */
  admits(): boolean;
}

/**
 * Адрес, по которому пришла строка: чем он отвечает на решения `allow`
 * и `ask`. На `deny` адрес не влияет — отказ одинаков везде.
 */
export interface Address {
  onAllow(): Treatment;
  onAsk(): Treatment;
}

/** Что решение добавляет после стрелки в вопросе об изменении правила. */
interface Caveat {
  after(word: string, path: RulePath, writers: Writers): string;
}

/** Решение правила: исход по адресу и изменение правила этим решением. */
export class Verdict implements Change {
  readonly word: string;
  readonly #at: (address: Address) => Treatment;
  readonly #caveat: Caveat;

  /**
   * @param word слово решения в файле и в `policy`
   * @param at исход решения у адреса строки
   * @param caveat что вопрос об изменении правила добавляет после стрелки
   */
  constructor(
    word: string,
    at: (address: Address) => Treatment,
    caveat: Caveat,
  ) {
    this.word = word;
    this.#at = at;
    this.#caveat = caveat;
  }

  /**
   * Исполняет исход решения.
   *
   * @param execution строка под решением
   * @param channel у кого спросить
   * @param won путь выигравшего правила текстом
   * @param address адрес, по которому пришла строка
   */
  settle<T>(
    execution: Execution<T>,
    channel: Channel,
    won: string,
    address: Address,
  ): Promise<T> {
    return this.#at(address).settle(execution, channel, won);
  }

  /** Исполняется ли строка с этим решением по адресу `address`. */
  admits(address: Address): boolean {
    return this.#at(address).admits();
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

/** Исполнить строку. */
export const EXECUTE: Treatment = {
  settle: (execution) => execution.run(),
  admits: () => true,
};

/** Спросить канал; «да» — исполнить. */
export const CONFIRM: Treatment = {
  settle(execution, channel) {
    const text = execution.text;
    return channel.ask(`выполнить ${text}? [y/N] `, {
      yes: () => execution.run(),
      no: () => execution.refuse(NOT_CONFIRMED, `${text}: ${NOT_CONFIRMED}`),
      absent: () =>
        execution.refuse(NOBODY_TO_ASK, `${text}: ${NOBODY_TO_ASK}`),
    });
  },
  admits: () => true,
};

/** Адрес не тот: ни вопроса, ни исполнения. */
export const REDIRECT: Treatment = {
  settle: (execution) => execution.redirect(),
  admits: () => false,
};

const FORBIDDEN: Treatment = {
  settle: (execution, _channel, won) =>
    execution.refuse(
      DENIED,
      `${execution.text}: ${DENIED} «${won}»`,
    ),
  admits: () => false,
};

export const ALLOW: Verdict = new Verdict(
  "allow",
  (address) => address.onAllow(),
  OPENS_WRITERS,
);
export const ASK: Verdict = new Verdict(
  "ask",
  (address) => address.onAsk(),
  PLAIN,
);
export const DENY: Verdict = new Verdict("deny", () => FORBIDDEN, PLAIN);

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
