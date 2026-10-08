/**
 * Имена, связанные разбором: переменные программы (присваиванием выше и
 * в том же выражении — блок может звать себя) и параметры охватывающих
 * блоков. По ним голое слово в начале выражения — переменная, а не
 * сообщение корню.
 */

import { GRAMMAR } from "../messages/mod.ts";
import { NO_PARAMS, type Params } from "./params.ts";

/** Где искать имя, которого нет среди своих. */
interface Outer {
  has(name: string): boolean;
  /** Видимые имена — в `into`. */
  collect(into: Set<string>): void;
}

/** Над программой имён нет. */
const NONE: Outer = { has: () => false, collect() {} };

/** Связанные имена одного уровня: программы или тела блока. */
export class Names implements Outer {
  readonly #own = new Set<string>();
  readonly #outer: Outer;
  readonly #params: Params;

  /**
   * @param params параметры программы: связывание их имени — отказ
   *   (`platform/program-input.md`, «Параметры»)
   */
  constructor(outer: Outer = NONE, params: Params = NO_PARAMS) {
    this.#outer = outer;
    this.#params = params;
  }

  /** Имена тела блока с параметрами `params`. */
  inner(params: readonly string[]): Names {
    const names = new Names(this, this.#params);
    for (const param of params) {
      this.#params.binds(
        param,
        `параметром блока ${GRAMMAR.parameter}${param}`,
      );
      names.#own.add(param);
    }
    return names;
  }

  bind(name: string) {
    this.#params.binds(name, `переменной ${name} ${GRAMMAR.assign}`);
    this.#own.add(name);
  }

  has(name: string): boolean {
    return this.#own.has(name) || this.#outer.has(name);
  }

  collect(into: Set<string>) {
    this.#outer.collect(into);
    for (const name of this.#own) into.add(name);
  }

  /** Все видимые имена по алфавиту. */
  list(): string[] {
    const all = new Set<string>();
    this.collect(all);
    return [...all].sort();
  }
}
