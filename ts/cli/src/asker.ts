import type { AskKind } from "../../back/src/frames/mod.ts";
import type { TerminalIo } from "./terminal/mod.ts";

/**
 * Кто отвечает на кадр `ask` (`cli-client.md`, «Канал и токен»): человек
 * за терминалом или никто. Выбирается один раз при старте.
 */

/** Отвечающий на вопрос сервера. */
export interface Asker {
  /** Есть ли кого спросить — поле `human` первого кадра. */
  readonly present: boolean;
  /**
   * Ответ на вопрос; ответа не будет — пустая строка (для сервера
   * «нет»). Вид вопроса выбирает, как читать: видимо или без эха.
   */
  answer(question: string, kind: AskKind): Promise<string>;
}

/**
 * Человек за управляющим терминалом: вопрос показывается там же, где
 * его увидит человек, ответ читается оттуда же (`cli-client.md`,
 * «Канал и токен»). Два вида чтения — две реализации, выбранные видом
 * вопроса, а не проверка «скрытый ли» на каждом чтении
 * (`platform/line-prompt.md`).
 *
 * @param open открыть управляющий терминал; его нет — ответа не будет
 */
export function humanAsker(
  open: () => Promise<TerminalIo | undefined>,
): Asker {
  return {
    present: true,
    answer: async (question, kind) => {
      using terminal = await open();
      // Терминал исчез между стартом и вопросом: для сервера это
      // пустой ответ, то есть «нет».
      if (terminal === undefined) return "";
      await terminal.write(question);
      const reading: Readonly<
        Record<AskKind, () => Promise<string | undefined>>
      > = {
        line: () => terminal.readLine(),
        secret: () => terminal.readSecret(),
      };
      return (await reading[kind]()) ?? "";
    },
  };
}

/** Спросить некого: ответ «нет» сразу. */
export const NOBODY: Asker = {
  present: false,
  answer: () => Promise.resolve(""),
};
