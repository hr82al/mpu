/**
 * Кто отвечает на кадр `ask` (`cli-client.md`, «Канал и токен»): человек
 * за терминалом или никто. Выбирается один раз при старте.
 */

/** Отвечающий на вопрос сервера. */
export interface Asker {
  /** Есть ли кого спросить — поле `human` первого кадра. */
  readonly present: boolean;
  /** Ответ на вопрос; ответа не будет — пустая строка (для сервера «нет»). */
  answer(question: string): Promise<string>;
}

/** Человек: вопрос в stderr без перевода строки, ответ — строка stdin. */
export function humanAsker(
  stderr: (text: string) => void,
  readLine: () => Promise<string | undefined>,
): Asker {
  return {
    present: true,
    answer: async (question) => {
      stderr(question);
      return (await readLine()) ?? "";
    },
  };
}

/** Спросить некого: ответ «нет» сразу. */
export const NOBODY: Asker = {
  present: false,
  answer: () => Promise.resolve(""),
};
