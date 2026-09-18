/**
 * Как находится решение (`platform/policy.md`): правило на пути действует
 * на этот путь и на всё под ним, из совпавших побеждает самое длинное,
 * не совпало ни одно — наследуемое правило корня.
 */

import type { Channel } from "./channel.ts";
import type { RulePath } from "./path.ts";
import {
  ASK,
  type Execution,
  type RuleEntry,
  type Verdict,
} from "./verdict.ts";

/** Решение для строки: исполняет исход и называет себя эталону. */
export interface Ruling {
  settle<T>(execution: Execution<T>, channel: Channel): Promise<T>;
  /** Решение и путь выигравшего правила (`null` — не совпало ни одно). */
  record(): { readonly verdict: string; readonly won: string | null };
  /** Уступает ли это решение правилу `challenger`, совпавшему с той же строкой. */
  yieldsTo(challenger: Rule): boolean;
}

/** Правило: путь и решение. */
export class Rule implements Ruling {
  readonly #path: RulePath;
  readonly #verdict: Verdict;

  constructor(path: RulePath, verdict: Verdict) {
    this.#path = path;
    this.#verdict = verdict;
  }

  settle<T>(execution: Execution<T>, channel: Channel): Promise<T> {
    return this.#verdict.settle(execution, channel, this.#path.text());
  }

  record() {
    return { verdict: this.#verdict.word, won: this.#path.text() };
  }

  yieldsTo(challenger: Rule): boolean {
    return challenger.#path.longer(this.#path);
  }

  /** Правило для строки `links`: это, если оно действует и сильнее `rival`. */
  over(links: readonly string[], rival: Ruling): Ruling {
    if (!this.#path.covers(links)) return rival;
    return rival.yieldsTo(this) ? this : rival;
  }

  entry(): RuleEntry {
    return { path: this.#path.text(), verdict: this.#verdict.word };
  }
}

/**
 * Наследуемое правило: ни одно не совпало, решение корня — спросить.
 * Уступает любому совпавшему. Единственный null-объект модуля.
 */
export const INHERITED: Ruling = {
  settle: (execution, channel) => ASK.settle(execution, channel, ""),
  record: () => ({ verdict: ASK.word, won: null }),
  yieldsTo: () => true,
};

/** Набор правил. */
export class Rules {
  readonly #rules: readonly Rule[];

  constructor(rules: readonly Rule[]) {
    this.#rules = [...rules];
  }

  /** Решение для пути строки: самое длинное совпавшее правило. */
  decide(links: readonly string[]): Ruling {
    let won = INHERITED;
    for (const rule of this.#rules) won = rule.over(links, won);
    return won;
  }

  /** Правила по пути правила, по алфавиту (`*` первым). */
  list(): RuleEntry[] {
    return this.#rules
      .map((rule) => rule.entry())
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }
}
