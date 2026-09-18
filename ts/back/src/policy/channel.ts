/**
 * Канал вызова: у кого спросить подтверждение (`platform/policy.md`,
 * «Канал вызова»). С человеком и без — две реализации одного протокола;
 * что делать с ответом, решает спросивший.
 */

/** Что делает спросивший на каждый исход вопроса. */
export interface Reply<T> {
  yes(): Promise<T>;
  no(): Promise<T>;
  /** Спросить некого. */
  absent(): Promise<T>;
}

/** Протокол «спросить». */
export interface Channel {
  /** Вопрос о строке с решением `ask`. */
  ask<T>(question: string, reply: Reply<T>): Promise<T>;
  /** Вопрос об изменении правила: отвечать на него может только человек. */
  amend<T>(question: string, reply: Reply<T>): Promise<T>;
}

/** Ответы «да»: `y` и `yes` в любом регистре; всё прочее — «нет». */
const YES: ReadonlySet<string> = new Set(["y", "yes"]);

/** Канал с человеком: вопрос в поток без перевода строки, ответ — строка. */
export class Human implements Channel {
  readonly #write: (text: string) => void;
  readonly #readLine: () => Promise<string | undefined>;

  /**
   * @param write поток вопроса (stderr)
   * @param readLine одна строка ответа; конец ввода — `undefined`
   */
  constructor(
    write: (text: string) => void,
    readLine: () => Promise<string | undefined>,
  ) {
    this.#write = write;
    this.#readLine = readLine;
  }

  async ask<T>(question: string, reply: Reply<T>): Promise<T> {
    this.#write(question);
    const answer = (await this.#readLine()) ?? "";
    if (YES.has(answer.trim().toLowerCase())) return await reply.yes();
    return await reply.no();
  }

  amend<T>(question: string, reply: Reply<T>): Promise<T> {
    return this.ask(question, reply);
  }
}

/** Канал без человека: спросить некого. */
export const NOBODY: Channel = {
  ask: (_question, reply) => reply.absent(),
  amend: (_question, reply) => reply.absent(),
};

/**
 * Канал агента: о строке с решением `ask` спрашивает того, кто за
 * агентом (`inner`), а изменить правило через агента нельзя — вопрос
 * не задаётся никому (`platform/back-rpc.md`, «Строка»).
 */
export class Agent implements Channel {
  readonly #inner: Channel;

  constructor(inner: Channel) {
    this.#inner = inner;
  }

  ask<T>(question: string, reply: Reply<T>): Promise<T> {
    return this.#inner.ask(question, reply);
  }

  amend<T>(_question: string, reply: Reply<T>): Promise<T> {
    return reply.absent();
  }
}
