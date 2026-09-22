import type { Trace } from "./protocol.ts";

/**
 * Пройденный путь цепочки: звенья для правил, слова для правил и адрес —
 * все слова строки по порядку, со словами в стороне (вход `ask`, `end`,
 * формат). Вход бывает только у корня, поэтому `through` ставит его сразу
 * за началом.
 */
export class Trail implements Trace {
  readonly #links: string[] = [];
  readonly #start: string[] = [];
  readonly #texts: string[] = [];
  readonly #address: string[] = [];

  step(link: string, text: string) {
    this.#links.push(link);
    this.#texts.push(text);
    this.#address.push(text);
  }

  begin(text: string) {
    this.#start.push(text);
    this.#address.push(text);
  }

  aside(text: string) {
    this.#address.push(text);
  }

  textWith(text: string): string {
    return [...this.#address, text].join(" ");
  }

  /** Адрес до текущего приёмника: как строку набрали. */
  address(): string {
    return this.#address.join(" ");
  }

  /** Путь без слов в стороне: так строку называют правила. */
  text(): string {
    return [...this.#start, ...this.#texts].join(" ");
  }

  /** Путь, набранный через вход `gate`. */
  through(gate: string): string {
    return [...this.#start, gate, ...this.#texts].join(" ");
  }

  /** Звенья — копией. */
  links(): string[] {
    return [...this.#links];
  }

  copy(): Trail {
    const copy = new Trail();
    copy.#links.push(...this.#links);
    copy.#start.push(...this.#start);
    copy.#texts.push(...this.#texts);
    copy.#address.push(...this.#address);
    return copy;
  }
}
