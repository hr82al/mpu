/**
 * Объект-справка (`platform/line-grammar.md` [D.4]): ответ на сообщение
 * `help` — данные о приёмнике. Текст справки — один из видов этих данных,
 * `json` — другой.
 */

import type { KeyKind } from "../messages/mod.ts";

/** Ключ ключевого сообщения глазами справки. */
export interface HelpKey {
  readonly name: string;
  readonly kind: KeyKind;
  readonly required: boolean;
  readonly purpose: string;
}

/** Сообщение, которое понимает объект: селектор и назначение. */
export interface HelpMessage {
  readonly selector: string;
  readonly purpose: string;
}

/** Данные справки — то, что видит формат `json`. */
export interface HelpData {
  readonly path: string;
  readonly purpose: string;
  readonly text: string;
  readonly examples: readonly string[];
  readonly keys: readonly HelpKey[];
  readonly formats: readonly string[];
  readonly messages: readonly HelpMessage[];
}

/** Как справка выглядит текстом: у объекта и у данных — по-разному. */
export interface HelpView {
  render(data: HelpData): string;
}

/** Справка объекта: строка использования и раздел «Сообщения». */
export const OBJECT_VIEW: HelpView = {
  render(data) {
    const width = Math.max(
      ...data.messages.map((message) => message.selector.length),
    ) + 2;
    const messages = data.messages
      .map((line) => `  ${line.selector.padEnd(width)}${line.purpose}\n`)
      .join("");
    return `Использование: ${data.path} <сообщение>\n\n${data.purpose}\n\n` +
      `${data.text}\n\nСообщения:\n${messages}`;
  },
};

/** Справка метода, отдающего данные: путь, назначение, текст. */
export const DATA_VIEW: HelpView = {
  render: (data) => `${data.path}\n\n${data.purpose}\n\n${data.text}\n`,
};

/** Справка: данные и их текстовый вид. */
export class Help {
  readonly #data: HelpData;
  readonly #view: HelpView;

  constructor(data: HelpData, view: HelpView) {
    this.#data = data;
    this.#view = view;
  }

  /** Вид по умолчанию — текст справки. */
  text(): string {
    return this.#view.render(this.#data);
  }

  /** Данные справки — копией. */
  data(): HelpData {
    return structuredClone(this.#data);
  }
}
