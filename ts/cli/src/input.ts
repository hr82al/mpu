/**
 * Ввод клиента по запросу строки (`platform/stdin-on-request.md`): stdin
 * читается, только когда строка его попросила, и не больше одного раза.
 * Строка, которой ввод не нужен, stdin не касается — даже открытый канал
 * без писателя её не держит.
 */

import {
  BadFrame,
  boundedInput,
  type CallerFacts,
  isBareLine,
  NotUtf8,
  utf8Of,
} from "@mpu/language/frames";

/** Что клиент отвечает на кадр `stdinRequest`. */
export interface ClientInput {
  /**
   * Весь ввод текстом для кадра `stdin`; повторный запрос — то же.
   *
   * @throws BadFrame — ввод больше предела: тот же отказ, что у сервера;
   *   у строки без слов — ещё ввод не в UTF-8
   */
  supply(): Promise<string>;
}

/**
 * stdin — терминал: ввода нет, и читать терминал до конца нельзя —
 * клиент повис бы. Сервер при терминале ввод не запрашивает (поле
 * `stdinOnRequest` не ушло); запросивший вопреки этому получает пустой
 * ввод, а не ожидание без конца.
 */
const TERMINAL_INPUT: ClientInput = { supply: () => Promise.resolve("") };

/** Как байты ввода становятся текстом кадра `stdin`. */
interface InputText {
  /** @throws BadFrame — ввод отвергнут клиентом */
  of(bytes: Uint8Array): string;
}

/** Ввод строки со словами — как прежде: без проверки UTF-8. */
const LINE_TEXT: InputText = { of: (bytes) => new TextDecoder().decode(bytes) };

/**
 * Ввод строки без слов: слова в нём — прежняя форма, её отказывает сервер
 * (`platform/stage6-l1.md`); байты не в UTF-8 отвергаются до сервера, BOM
 * уходит как есть — его снимают слова.
 */
const BARE_TEXT: InputText = {
  of(bytes) {
    try {
      return utf8Of(bytes);
    } catch (err) {
      if (!(err instanceof NotUtf8)) throw err;
      throw new BadFrame(err.message, `ввод ${err.message}`);
    }
  },
};

/** stdin — пайп или файл: читается целиком при первом запросе. */
class PipedInput implements ClientInput {
  readonly #read: () => Promise<Uint8Array>;
  readonly #text: InputText;
  /** Первый запрос читает, следующие берут прочитанное. */
  #supply = (): Promise<string> => {
    const text = this.#bounded();
    this.#supply = () => text;
    return text;
  };

  constructor(read: () => Promise<Uint8Array>, text: InputText) {
    this.#read = read;
    this.#text = text;
  }

  supply(): Promise<string> {
    return this.#supply();
  }

  async #bounded(): Promise<string> {
    const text = this.#text.of(await this.#read());
    boundedInput(text);
    return text;
  }
}

/**
 * Ввод клиента по его stdin.
 *
 * @param facts чем клиент снимает свой контекст
 * @param words слова строки: без слов ввод проверяется на UTF-8
 */
export function clientInput(
  facts: CallerFacts,
  words: readonly string[],
): ClientInput {
  if (facts.stdinIsTerminal()) return TERMINAL_INPUT;
  const text = isBareLine(words) ? BARE_TEXT : LINE_TEXT;
  return new PipedInput(() => facts.stdin(), text);
}
