/**
 * Допуск запроса (`docs/specs/call.md`, «Пункты чек-листа» 2): чтение и
 * запись — две реализации одного протокола, а не флаг. `call-ro` пускает
 * только ручки реестра чтения, `call` — любой запрос известного хоста.
 */

import { UsageError } from "@mpu/command";
import type { Aim } from "./address.ts";
import { type Method, type ReadRule } from "./reads.ts";

/** Запрос глазами допуска: куда и каким методом. */
export interface Aimed extends Aim {
  readonly method: Method;
}

/** Допуск запроса команды. */
export interface Access {
  /**
   * Метод запроса: заданный вызывающим, иначе — умолчание допуска.
   *
   * @param usual умолчание получателя-маркетплейса
   */
  method(
    host: string,
    path: string,
    given: Method | undefined,
    usual: Method,
  ): Method;
  /**
   * Отказ ввода, если запрос не пускается. Зовётся до чтения ключа.
   *
   * @param writing строка той же команды записью — для текста отказа
   */
  admit(request: Aimed, writing: string): void;
}

/** Любой запрос известного хоста: `call`, запись через дверь `ask`. */
export const ANY_REQUEST: Access = {
  method: (_host, _path, given, usual) => given ?? usual,
  admit: () => {},
};

/** Только ручки реестра чтения: `call-ro`. */
export class ReadList implements Access {
  readonly #rules: readonly ReadRule[];

  constructor(rules: readonly ReadRule[]) {
    this.#rules = rules;
  }

  /**
   * Не задан — метод правила ручки, если оно у неё одно: у `/v1/actions`
   * в реестре только `GET`, и умолчание получателя (`POST`) дало бы отказ
   * на чтении, которое реестр разрешает.
   */
  method(
    host: string,
    path: string,
    given: Method | undefined,
    usual: Method,
  ): Method {
    if (given !== undefined) return given;
    const named = this.#rules.filter((rule) => rule.names(host, path));
    return named.length === 1 ? named[0].method : usual;
  }

  admit(request: Aimed, writing: string): void {
    const { method, host, path, named } = request;
    if (this.#rules.some((rule) => rule.matches(method, host, path))) return;
    throw new UsageError(
      `ручки ${method} ${named} нет в списке чтения — запись: ${writing}`,
    );
  }
}
