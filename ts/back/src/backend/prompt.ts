/**
 * Вопрос строки тому, кто её позвал (`platform/line-prompt.md`):
 * видимый ответ, скрытый ответ и просьба положить текст в буфер
 * обмена. Сервер сам ничего не показывает и никуда не копирует — он
 * только просит клиента, а как это сделать, решает клиент.
 */

import type { Answer, Prompt } from "../command/mod.ts";
import type { AskKind, ServerFrame } from "../frames/mod.ts";

/** Что вопросу нужно от строки: спросить, дождаться, послать кадр. */
export interface Asking {
  question(text: string, kind: AskKind): void;
  answer(): Promise<string | undefined>;
  deliver(frame: ServerFrame): void;
}

/** Что даёт строке её дверь: какие вопросы и просьбы по ней проходят. */
export interface PromptDoor {
  /** Задаётся ли вопрос этого вида на этой двери. */
  asks(kind: AskKind): boolean;
  /** Предлагается ли копирование. */
  copies(): boolean;
}

/**
 * Вопрос кадрами строки: `ask` с видом, ответ — кадром `answer`,
 * копирование — кадром `clip`. То, чего дверь не предлагает, уходит
 * `NO_ONE`: спросивший получает `absent()`, а не молчание.
 *
 * @param line строка, которая спрашивает
 * @param door что проходит по её двери
 */
export function linePrompt(line: Asking, door: PromptDoor): Prompt {
  const asked = async <T>(
    kind: AskKind,
    question: string,
    answer: Answer<T>,
  ): Promise<T> => {
    if (!door.asks(kind)) return await answer.absent();
    line.question(question, kind);
    // Молчание клиента — пустой ответ, а не «спросить некого»: спросили
    // ведь, и человек либо закрыл ввод, либо не ответил за срок
    // (`platform/back-rpc.md`), либо строку успели остановить.
    return await answer.given(await line.answer() ?? "");
  };
  return {
    line: (question, answer) => asked("line", question, answer),
    secret: (question, answer) => asked("secret", question, answer),
    copy: (text) => {
      if (door.copies()) line.deliver({ clip: text });
      return Promise.resolve();
    },
  };
}
