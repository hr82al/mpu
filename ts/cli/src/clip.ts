/**
 * Куда клиент кладёт текст кадра `clip` (`platform/line-prompt.md`):
 * в буфер обмена своего терминала либо в stderr. Получатель выбирается
 * один раз при старте — вместе с отвечающим на вопросы, — а не
 * проверкой «есть ли буфер» перед каждым копированием.
 */

/** Получатель текста кадра `clip`. */
export interface Clip {
  put(text: string): Promise<void>;
}

/**
 * Буфер обмена терминала; копирование не удалось — текст в stderr,
 * и строка от этого не падает.
 *
 * @param copy положить текст в буфер; удалось ли
 * @param show напечатать текст в stderr
 */
export function clipboard(
  copy: (text: string) => Promise<boolean>,
  show: (text: string) => void,
): Clip {
  return {
    put: async (text) => {
      if (await copy(text)) return;
      show(`${text}\n`);
    },
  };
}

/**
 * Буфера нет — клиент в пайпе или без терминала: текст печатается в
 * stderr, буфер обмена не трогается вовсе.
 *
 * @param show напечатать текст в stderr
 */
export function shown(show: (text: string) => void): Clip {
  return {
    put: (text) => {
      show(`${text}\n`);
      return Promise.resolve();
    },
  };
}
