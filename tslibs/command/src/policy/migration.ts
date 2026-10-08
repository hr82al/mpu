/**
 * Разовая миграция посеянного правила (`platform/policy.md`, «Посев»):
 * правило пути, равное «было», один раз становится «стало».
 */

import type { RulePath } from "./path.ts";
import type { Verdict } from "./verdict.ts";

/** Миграция в записи файла правил. */
export interface MigrationEntry {
  /** Отметка выполненной миграции в файле. */
  readonly name: string;
  readonly path: string;
  readonly from: string;
  readonly to: string;
}

/**
 * Разовая замена правила пути: исполняется при первом открытии книги
 * версией, которая её знает, и помечается выполненной, даже если менять
 * было нечего, — правило, поставленное потом человеком, она не трогает.
 */
export class Migration {
  readonly #name: string;
  readonly #path: RulePath;
  readonly #from: Verdict;
  readonly #to: Verdict;

  constructor(name: string, path: RulePath, from: Verdict, to: Verdict) {
    this.#name = name;
    this.#path = path;
    this.#from = from;
    this.#to = to;
  }

  /** Запись для файла правил. */
  entry(): MigrationEntry {
    return {
      name: this.#name,
      path: this.#path.text(),
      from: this.#from.word,
      to: this.#to.word,
    };
  }
}
