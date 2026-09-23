/**
 * Область имён программы во время исполнения: переменные программы и
 * параметры блоков. Присваивание находит имя в цепочке областей, а не
 * найдя — связывает его здесь.
 */

import type { Value } from "./protocol.ts";

/** Где искать имя, которого нет в этой области. */
interface Outer {
  /** Значение имени; нет нигде — `absent`. */
  find(name: string, absent: Value): Value;
  /** Переписать имя, если оно связано здесь или выше. */
  rebind(name: string, value: Value): boolean;
}

/** Над программой ничего нет. */
const NOTHING: Outer = {
  find: (_name, absent) => absent,
  rebind: () => false,
};

/** Область: свои имена и внешняя область. */
export class Scope implements Outer {
  readonly #names = new Map<string, Value>();
  readonly #outer: Outer;

  /** @param outer охватывающая область; у программы — никакой */
  constructor(outer: Outer = NOTHING) {
    this.#outer = outer;
  }

  /** Область блока внутри этой с параметрами `names` = `values`. */
  inner(names: readonly string[], values: readonly Value[]): Scope {
    const scope = new Scope(this);
    names.forEach((name, i) => scope.#names.set(name, values[i]));
    return scope;
  }

  /**
   * Значение имени. Имя, связанное разбором, но ещё не присвоенное
   * исполнением (`f := do … @f … done`), — `absent`.
   */
  find(name: string, absent: Value): Value {
    return this.#names.get(name) ?? this.#outer.find(name, absent);
  }

  /** Присваивание: имя выше — переписывается там, иначе — здесь. */
  assign(name: string, value: Value) {
    if (!this.rebind(name, value)) this.#names.set(name, value);
  }

  rebind(name: string, value: Value): boolean {
    if (this.#names.has(name)) {
      this.#names.set(name, value);
      return true;
    }
    return this.#outer.rebind(name, value);
  }
}
