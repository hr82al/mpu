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
  readonly #missing: string;

  constructor(options: {
    /** Слова строки. */
    readonly words: readonly string[];
    /** Причина, когда ядро не ответило решением. */
    readonly unavailable: string;
    /** Чего нет в строке «без …»: `без решения`, `без вопроса`. */
    readonly missing: string;
  }) {
    this.words = [...options.words];
    this.#unavailable = options.unavailable;
    this.#missing = options.missing;
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
   * Строка «без решения» («без вопроса») для stderr: Claude Code решает
   * вызов сам.
   *
   * @param reason причина — постоянная строка, без значений ключей строки
   */
  undecided(reason: string): string {
    return `mpu ${this.words.join(" ")}: ${this.#missing} — ${reason}\n`;
  }

  /** Причина: ядро не ответило решением. */
  unavailable(cause: string): string {
    return `${this.#unavailable}: ${cause}`;
  }
}

/** Хук `PreToolUse`: решение правил mpu. */
export const PRE_TOOL_USE = new HookWords({
  words: ["claude-hook", "pre-tool-use"],
  unavailable: "правила недоступны",
  missing: "без решения",
});

/**
 * Хук `PermissionRequest`: вопрос владельцу в Telegram
 * (`claude-hook-permission-request.md`, «CLI-контракт» [D.3]).
 */
export const PERMISSION_REQUEST = new HookWords({
  words: ["claude-hook", "permission-request"],
  unavailable: "сервер mpu не отвечает",
  missing: "без решения",
});

/**
 * Хук `Stop`: сообщение «ждёт ввода» в Telegram (`claude-hook-stop.md`,
 * «CLI-контракт»). Решения у него нет — нет и вопроса, если не поставлен.
 */
export const STOP = new HookWords({
  words: ["claude-hook", "stop"],
  unavailable: "сервер mpu не отвечает",
  missing: "без вопроса",
});

/**
 * Хук `Notification` (`claude-hook-notification-snapshot.md`): строку
 * ведёт ядро, но в список строк-хуков клиента она не входит — у
 * строки-уведомления свои коды выхода (`claude-hook-notification.md`), их
 * видит журнал вызовов, и клиент их не подменяет.
 */
export const NOTIFICATION = new HookWords({
  words: ["claude-hook", "notification"],
  unavailable: "сервер mpu не отвечает",
  missing: "без уведомления",
});

/**
 * Хук `Elicitation`: форма MCP-сервера владельцу в Telegram
 * (`claude-hook-elicitation.md`, «CLI-контракт»).
 */
export const ELICITATION = new HookWords({
  words: ["claude-hook", "elicitation"],
  unavailable: "сервер mpu не отвечает",
  missing: "без решения",
});

/** Строки-хуки — один список на клиента и ядро. */
export const HOOK_LINES: readonly HookWords[] = [
  PRE_TOOL_USE,
  PERMISSION_REQUEST,
  STOP,
  ELICITATION,
];
