import type { Trace } from "./protocol.ts";

/** Пройденный путь цепочки: звенья для правил и слова для человека. */
export class Trail implements Trace {
  readonly #links: string[] = [];
  readonly #texts: string[] = [];

  step(link: string, text: string) {
    this.#links.push(link);
    this.#texts.push(text);
  }

  begin(text: string) {
    this.#texts.push(text);
  }

  textWith(text: string): string {
    return [...this.#texts, text].join(" ");
  }

  /** Текст пути до текущего приёмника. */
  text(): string {
    return this.#texts.join(" ");
  }

  /** Звенья — копией. */
  links(): string[] {
    return [...this.#links];
  }

  copy(): Trail {
    const copy = new Trail();
    copy.#links.push(...this.#links);
    copy.#texts.push(...this.#texts);
    return copy;
  }
}
