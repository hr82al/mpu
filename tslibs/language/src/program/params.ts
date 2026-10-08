/**
 * Параметры программы из файла (`platform/program-input.md`, «Параметры»):
 * ключи вызова `mpu run: x.mpu col: review` видны программе только как
 * `@col`. Голое имя параметром не становится — его решают связывания
 * самой программы.
 */

import { NO_HINT, RefusalNotice, type Refused } from "../objects/mod.ts";
import { Text } from "./objects.ts";
import type { Value } from "./protocol.ts";

/**
 * Отказ источника до исполнения: параметр ждут, а его не передали, или
 * программа связывает переданное имя. Префикс — источник, а не место
 * выражения.
 */
export class ParamRefusal extends Error {
  override name = "ParamRefusal";
  readonly refused: Refused;

  constructor(refused: Refused) {
    super(refused.data().text);
    this.refused = refused;
  }
}

/** Параметры программы глазами разбора, исполнения и кадра. */
export interface Params {
  /** `@name` связана переданным параметром. */
  bound(name: string): boolean;
  /**
   * `@name` не связана ничем: у файла — отказ «ждёт параметр», у прочих —
   * обычный отказ `unbound`.
   */
  missing(name: string, unbound: () => Error): Error;
  /**
   * Программа связывает `name`; `as` — как (`переменной col :=`).
   *
   * @throws ParamRefusal — `name` передан параметром
   */
  binds(name: string, as: string): void;
  /** Значение параметра — внешняя область программы; нет — `absent`. */
  find(name: string, absent: Value): Value;
  /** Параметр не переписывается: связать его программа не может. */
  rebind(name: string, value: Value): boolean;
  /** Поле кадра исполнителю; параметров нет — `null`. */
  frame(): Readonly<Record<string, string>> | null;
}

/** Набранная строка и stdin: параметров нет, `@x` — обычный отказ. */
export const NO_PARAMS: Params = {
  bound: () => false,
  missing: (_name, unbound) => unbound(),
  binds() {},
  find: (_name, absent) => absent,
  rebind: () => false,
  frame: () => null,
};

/** Вид отказа: использованный параметр не передан. */
const AWAITED = "ждёт параметр";

/** Вид отказа: программа связывает имя переданного параметра. */
const CLASHES = "совпадает с переменной";

/** Параметры файла `run:`: ключи вызова и сам вызов для текста отказа. */
class FileParams implements Params {
  readonly #source: string;
  readonly #values: ReadonlyMap<string, string>;

  constructor(source: string, values: ReadonlyMap<string, string>) {
    this.#source = source;
    this.#values = values;
  }

  bound(name: string): boolean {
    return this.#values.has(name);
  }

  missing(name: string): Error {
    return this.#refusal(
      AWAITED,
      `программа ждёт параметр ${name}: — ${this.#source} ${name}: …`,
    );
  }

  binds(name: string, as: string) {
    if (!this.#values.has(name)) return;
    throw this.#refusal(
      CLASHES,
      `параметр ${name}: совпадает с ${as} — переименуй одно из них`,
    );
  }

  find(name: string, absent: Value): Value {
    const value = this.#values.get(name);
    return value === undefined ? absent : new Text(value);
  }

  rebind(): boolean {
    return false;
  }

  frame(): Readonly<Record<string, string>> {
    return Object.fromEntries(this.#values);
  }

  #refusal(reason: string, text: string): ParamRefusal {
    return new ParamRefusal(
      new RefusalNotice({
        reason,
        said: `${this.#source}: ${text}`,
        hint: NO_HINT,
        candidates: [],
      }),
    );
  }
}

/**
 * Параметры программы из файла.
 *
 * @param source как отказ называет вызов (`mpu run: x.mpu col: review`)
 * @param values переданные ключи: имя → значение
 */
export function fileParams(
  source: string,
  values: ReadonlyMap<string, string>,
): Params {
  return new FileParams(source, values);
}

/**
 * Параметры по полю кадра (граница кадра исполнителю): `null` —
 * параметров нет.
 */
export function paramsOf(
  source: string,
  values: Readonly<Record<string, string>> | null,
): Params {
  if (values === null) return NO_PARAMS;
  return new FileParams(source, new Map(Object.entries(values)));
}
