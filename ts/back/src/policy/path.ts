/** Путь корня в тексте и хвостовое звено «всё ниже». */
const ROOT = "*";

/** Значение ключа не дало ни одного звена. */
export class EmptyRulePath extends Error {
  override name = "EmptyRulePath";
}

/**
 * Путь правила — звенья, а не строка: совпадение ищется по звеньям,
 * поэтому `kiten` не начало `kitenx ls` (`platform/policy.md`, «Термины»).
 */
export class RulePath {
  readonly #links: readonly string[];

  private constructor(links: readonly string[]) {
    this.#links = links;
  }

  /**
   * Путь из текста: звенья через пробелы любой длины, хвостовое `*`
   * отбрасывается (`kiten *` ≡ `kiten`), `*` — корень.
   *
   * @param text путь правила, как его набрали
   * @throws EmptyRulePath — в тексте нет ни одного звена
   */
  static parse(text: string): RulePath {
    const links = text.split(/\s+/).filter((link) => link !== "");
    if (links.length === 0) throw new EmptyRulePath("путь правила пуст");
    while (links.at(-1) === ROOT) links.pop();
    return new RulePath(links);
  }

  /** Текст пути: звенья через пробел, корень — `*`. */
  text(): string {
    return this.#links.length === 0 ? ROOT : this.#links.join(" ");
  }

  /** Начало ли этот путь пути строки — по звеньям. */
  covers(links: readonly string[]): boolean {
    return this.#links.length <= links.length &&
      this.#links.every((link, i) => link === links[i]);
  }

  /** Длиннее ли этот путь пути `other`: длинное совпадение сильнее. */
  longer(other: RulePath): boolean {
    return this.#links.length > other.#links.length;
  }
}
