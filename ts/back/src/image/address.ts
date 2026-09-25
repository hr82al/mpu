/**
 * Адрес метода в ключах `base:`/`files:` (`image-sync.md`, «Адрес метода
 * в `base:`/`files:`»): одно слово — звенья получателя и имя через `.`,
 * имя без последнего двоеточия (`kiten.cardsIn`, `sheet.sum:with`).
 */

/** Разделитель звеньев адреса. */
const DOT = ".";

/** Слово — не адрес метода: причина строкой. */
export class Misaddressed extends Error {
  override name = "Misaddressed";
}

/** Метод по получателю и имени, как они хранятся. */
export interface Named {
  readonly receiver: readonly string[];
  readonly name: string;
}

/** Адрес метода: получатель и имя без последнего двоеточия. */
export class MethodAddress {
  readonly #receiver: readonly string[];
  readonly #written: string;

  private constructor(receiver: readonly string[], written: string) {
    this.#receiver = receiver;
    this.#written = written;
  }

  /**
   * Адрес из слова ключа.
   *
   * @throws Misaddressed — не `получатель.имя`
   */
  static parse(word: string): MethodAddress {
    const links = word.split(DOT);
    if (links.length < 2 || links.some((link) => link === "")) {
      throw new Misaddressed(`адрес метода — получатель.имя: ${word}`);
    }
    return new MethodAddress(links.slice(0, -1), links[links.length - 1]);
  }

  /** Адрес метода `method` — третье поле строки `конфликт`. */
  static of(method: Named): MethodAddress {
    const name = method.name.endsWith(":")
      ? method.name.slice(0, -1)
      : method.name;
    return new MethodAddress([...method.receiver], name);
  }

  /** Называет ли адрес метод: `kiten.mine` — и `mine`, и `mine:`. */
  names(method: Named): boolean {
    const { receiver, name } = method;
    return receiver.join(" ") === this.#receiver.join(" ") &&
      (name === this.#written || name === `${this.#written}:`);
  }

  /** Слово адреса, как его набирают в ключе. */
  text(): string {
    return [...this.#receiver, this.#written].join(DOT);
  }
}
