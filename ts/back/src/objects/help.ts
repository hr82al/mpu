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

/**
 * Текст справки с примерами: первый абзац — «когда звать», за ним
 * «Примеры:», за ними остальные абзацы. Примеров нет — текст как есть.
 */
function withExamples(text: string, examples: readonly string[]): string {
  if (examples.length === 0) return text;
  const cut = text.indexOf("\n\n");
  const first = cut < 0 ? text : text.slice(0, cut);
  const rest = cut < 0 ? "" : text.slice(cut);
  const lines = examples.map((example) => `  ${example}\n`).join("");
  return `${first}\n\nПримеры:\n${lines.trimEnd()}${rest}`;
}

/** Раздел справки: заголовок и строки «имя — назначение» в столбик. */
function section(
  title: string,
  rows: readonly (readonly [string, string])[],
): string {
  const width = Math.max(...rows.map(([name]) => name.length)) + 2;
  const lines = rows
    .map(([name, purpose]) => `  ${name.padEnd(width)}${purpose}\n`)
    .join("");
  return `\n\n${title}:\n${lines}`;
}

/** Ключ в справке: значение — с двоеточием, флаг — с `--`. */
function keyRow(key: HelpKey): readonly [string, string] {
  const name = key.kind === "flag" ? `--${key.name}` : `${key.name}:`;
  const required = key.required ? " (обязательный)" : "";
  return [name, `${key.purpose}${required}`];
}

/** Ключи, которых не называет ни одно сообщение (`card:` называет `card`). */
function unnamed(data: HelpData): HelpKey[] {
  const named = new Set(
    data.messages.flatMap((message) =>
      message.selector.split(":").filter((key) => key !== "")
    ),
  );
  return data.keys.filter((key) => !named.has(key.name));
}

/**
 * Справка объекта: строка использования, текст, раздел «Ключи» — ключи,
 * которых не называет ни одно сообщение, — и раздел «Сообщения», если
 * есть сообщения или нет ключей.
 */
export const OBJECT_VIEW: HelpView = {
  render(data) {
    const text = withExamples(data.text, data.examples);
    const shown = unnamed(data);
    const keys = shown.length === 0 ? "" : section("Ключи", shown.map(keyRow));
    const messages = data.messages.length === 0 && shown.length > 0
      ? ""
      : section(
        "Сообщения",
        data.messages.map((line) => [line.selector, line.purpose] as const),
      );
    return `Использование: ${data.path} <сообщение>\n\n${data.purpose}\n\n` +
      `${text}${keys}${messages}`;
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
