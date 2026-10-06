/**
 * Тело сообщения вопроса: заголовок, текст шага, строки вариантов
 * (`docs/specs/platform/telegram-questions.md`, «Сообщение»). Хвост —
 * строка `ещё ждут` или строка исхода — приставляется при выдаче текста:
 * тело одно, хвосты меняются.
 */

/** Предел текста сообщения Telegram, в кодовых единицах UTF-16. */
export const MESSAGE_LIMIT = 4096;

const CUT = "…";

/**
 * Начало `text` не длиннее `room` единиц UTF-16 с `…` в конце; пара
 * суррогатов не рвётся.
 */
function cut(text: string, room: number): string {
  if (text.length <= room) return text;
  if (room < CUT.length) return "";
  let end = room - CUT.length;
  // Обрыв между половинами суррогатной пары оставил бы непарную
  // половину — Telegram такой текст отвергает.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${CUT}`;
}

/** Тело сообщения, к которому приставляется хвост. */
export interface Body {
  /** Текст сообщения с хвостом `tail`, не длиннее предела. */
  text(tail: readonly string[]): string;
}

/** Тело сообщения одного шага. */
export class Card implements Body {
  readonly #title: string;
  readonly #text: string;
  readonly #lines: readonly string[];

  /**
   * @param title строка заголовка
   * @param text текст шага — единственное, что усекается
   * @param lines строки вариантов
   */
  constructor(title: string, text: string, lines: readonly string[]) {
    this.#title = title;
    this.#text = text;
    this.#lines = [...lines];
  }

  /**
   * Текст сообщения с хвостом `tail`, не длиннее предела: усекается
   * текст шага, заголовок, строки вариантов и хвост целы.
   */
  text(tail: readonly string[]): string {
    const fixed = [this.#title, ...this.#lines, ...tail];
    // Перевод строки на каждую из строк, кроме первой, плюс одна —
    // перед текстом шага.
    const used = fixed.reduce((sum, line) => sum + line.length, 0) +
      fixed.length;
    const step = cut(this.#text, MESSAGE_LIMIT - used);
    const lines = [this.#title, step, ...this.#lines, ...tail];
    // Одни неусекаемые части длиннее предела — режется хвост целого:
    // выход за предел Telegram отвергает, а не обрезает.
    return cut(lines.join("\n"), MESSAGE_LIMIT);
  }

  /** Запись для хранения до перезапуска (`shown.ts`). */
  toJSON(): { title: string; text: string; lines: readonly string[] } {
    return { title: this.#title, text: this.#text, lines: this.#lines };
  }

  /** Разбор записи; непригодная — тело из одного хвоста. */
  static parse(json: string): Body {
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      // Запись писало это же ядро; битая — только чужая правка базы,
      // и сообщение тогда правится одной строкой исхода.
      return EMPTY;
    }
    if (typeof value !== "object" || value === null) return EMPTY;
    const { title, text, lines } = value as Record<string, unknown>;
    if (typeof title !== "string" || typeof text !== "string") return EMPTY;
    if (!Array.isArray(lines) || !lines.every((l) => typeof l === "string")) {
      return EMPTY;
    }
    return new Card(title, text, lines);
  }
}

/** Тело без заголовка и шага: сообщение — один хвост. */
const EMPTY: Body = { text: (tail) => cut(tail.join("\n"), MESSAGE_LIMIT) };
