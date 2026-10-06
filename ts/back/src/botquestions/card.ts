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

/** Младшая половина суррогатной пары. */
function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Какой конец текста шага остаётся при усечении. Код — для записи тела
 * до перезапуска (`toJSON`).
 */
export interface Clip {
  readonly code: string;
  /** `text` не длиннее `room` единиц UTF-16. */
  fit(text: string, room: number): string;
}

/** Остаётся начало, `…` в конце — текст права, вопроса. */
export const KEEP_HEAD: Clip = { code: "head", fit: cut };

const TAIL_CUT = `${CUT}\n`;

/**
 * Остаётся конец, первой строкой `…` — последнее сообщение сессии: вопрос
 * в его конце (`claude-hook-stop.md` [S6]).
 */
export const KEEP_TAIL: Clip = {
  code: "tail",
  fit: (text, room) => {
    if (text.length <= room) return text;
    if (room < TAIL_CUT.length) return "";
    let start = text.length - (room - TAIL_CUT.length);
    // Начало на младшей половине суррогатной пары оставило бы непарную.
    if (isLow(text.charCodeAt(start))) start += 1;
    return `${TAIL_CUT}${text.slice(start)}`;
  },
};

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
  readonly #clip: Clip;

  /**
   * @param title строка заголовка
   * @param text текст шага — единственное, что усекается
   * @param lines строки вариантов
   * @param clip какой конец текста шага остаётся
   */
  constructor(
    title: string,
    text: string,
    lines: readonly string[],
    clip: Clip = KEEP_HEAD,
  ) {
    this.#title = title;
    this.#text = text;
    this.#lines = [...lines];
    this.#clip = clip;
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
    const step = this.#clip.fit(this.#text, MESSAGE_LIMIT - used);
    const lines = [this.#title, step, ...this.#lines, ...tail];
    // Одни неусекаемые части длиннее предела — режется хвост целого:
    // выход за предел Telegram отвергает, а не обрезает.
    return cut(lines.join("\n"), MESSAGE_LIMIT);
  }

  /** Запись для хранения до перезапуска (`shown.ts`). */
  toJSON(): {
    title: string;
    text: string;
    lines: readonly string[];
    clip: string;
  } {
    return {
      title: this.#title,
      text: this.#text,
      lines: this.#lines,
      clip: this.#clip.code,
    };
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
    const { title, text, lines, clip } = value as Record<string, unknown>;
    if (typeof title !== "string" || typeof text !== "string") return EMPTY;
    if (!Array.isArray(lines) || !lines.every((l) => typeof l === "string")) {
      return EMPTY;
    }
    // Записи до R2 поля нет: у них остаётся начало текста.
    return new Card(
      title,
      text,
      lines,
      clip === KEEP_TAIL.code ? KEEP_TAIL : KEEP_HEAD,
    );
  }
}

/** Тело без заголовка и шага: сообщение — один хвост. */
const EMPTY: Body = { text: (tail) => cut(tail.join("\n"), MESSAGE_LIMIT) };
