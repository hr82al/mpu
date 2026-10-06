/**
 * Строки-хуки Claude Code (`claude-hook-pre-tool-use.md`, «Клиент»): их
 * слова и строка «без решения». Лежат в контракте кадров, потому что у
 * них две стороны: ядро печатает причины, клиент — свою, когда ядро до
 * решения не дошло. Текст один на обе.
 */

/** Строка-хук: слова, по которым её узнают, и её строки «без решения». */
export class HookWords {
  /** Слова строки: по ним ядро и клиент узнают её. */
  readonly words: readonly string[];
  readonly #unavailable: string;

  /**
   * @param words слова строки
   * @param unavailable причина, когда ядро не ответило решением
   */
  constructor(words: readonly string[], unavailable: string) {
    this.words = [...words];
    this.#unavailable = unavailable;
  }

  /** Слова — ровно слова хука, без хвоста: так строку узнаёт клиент. */
  is(words: readonly string[]): boolean {
    return words.length === this.words.length && this.opens(words);
  }

  /**
   * Строка начинается словами хука: так её узнаёт маршрут ядра — хвост
   * (справка, лишнее слово) решает обычная цепочка.
   */
  opens(said: readonly string[]): boolean {
    return this.words.every((word, i) => said[i] === word);
  }

  /**
   * Строка «без решения» для stderr: Claude Code решает вызов сам.
   *
   * @param reason причина — постоянная строка, без значений ключей строки
   */
  undecided(reason: string): string {
    return `mpu ${this.words.join(" ")}: без решения — ${reason}\n`;
  }

  /** Причина: ядро не ответило решением. */
  unavailable(cause: string): string {
    return `${this.#unavailable}: ${cause}`;
  }
}

/** Хук `PreToolUse`: решение правил mpu. */
export const PRE_TOOL_USE = new HookWords(
  ["claude-hook", "pre-tool-use"],
  "правила недоступны",
);

/**
 * Хук `PermissionRequest`: вопрос владельцу в Telegram
 * (`claude-hook-permission-request.md`, «CLI-контракт» [D.3]).
 */
export const PERMISSION_REQUEST = new HookWords(
  ["claude-hook", "permission-request"],
  "сервер mpu не отвечает",
);

/** Строки-хуки — один список на клиента и ядро. */
export const HOOK_LINES: readonly HookWords[] = [
  PRE_TOOL_USE,
  PERMISSION_REQUEST,
];
