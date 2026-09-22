import type { Trace } from "./protocol.ts";

/**
 * Пройденный путь цепочки: звенья для правил, слова для человека и адрес
 * — слова вместе со словами входа. Вход бывает только у корня, поэтому
 * его слова стоят сразу за началом.
 */
export class Trail implements Trace {
  readonly #links: string[] = [];
  readonly #start: string[] = [];
  readonly #gates: string[] = [];
  readonly #texts: string[] = [];

  step(link: string, text: string) {
    this.#links.push(link);
    this.#texts.push(text);
  }

  begin(text: string) {
    this.#start.push(text);
  }

  gate(text: string) {
    this.#gates.push(text);
  }

  textWith(text: string): string {
    return [...this.#address(), text].join(" ");
  }

  /** Адрес до текущего приёмника: как строку набрали. */
  address(): string {
    return this.#address().join(" ");
  }

  /** Путь без слов входа: так строку называют правила. */
  text(): string {
    return this.through();
  }

  /** Путь, набранный через вход `gates`. */
  through(...gates: string[]): string {
    return [...this.#start, ...gates, ...this.#texts].join(" ");
  }

  /** Звенья — копией. */
  links(): string[] {
    return [...this.#links];
  }

  copy(): Trail {
    const copy = new Trail();
    copy.#links.push(...this.#links);
    copy.#start.push(...this.#start);
    copy.#gates.push(...this.#gates);
    copy.#texts.push(...this.#texts);
    return copy;
  }

  #address(): string[] {
    return [...this.#start, ...this.#gates, ...this.#texts];
  }
}
