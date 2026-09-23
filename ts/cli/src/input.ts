/**
 * Ввод клиента по запросу строки (`platform/stdin-on-request.md`): stdin
 * читается, только когда строка его попросила, и не больше одного раза.
 * Строка, которой ввод не нужен, stdin не касается — даже открытый канал
 * без писателя её не держит.
 */

import { boundedInput, type CallerFacts } from "../../back/src/frames/mod.ts";

/** Что клиент отвечает на кадр `stdinRequest`. */
export interface ClientInput {
  /**
   * Весь ввод текстом для кадра `stdin`; повторный запрос — то же.
   *
   * @throws BadFrame — ввод больше предела: тот же отказ, что у сервера
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

/** stdin — пайп или файл: читается целиком при первом запросе. */
class PipedInput implements ClientInput {
  readonly #read: () => Promise<string>;
  /** Первый запрос читает, следующие берут прочитанное. */
  #supply = (): Promise<string> => {
    const text = this.#bounded();
    this.#supply = () => text;
    return text;
  };

  constructor(read: () => Promise<string>) {
    this.#read = read;
  }

  supply(): Promise<string> {
    return this.#supply();
  }

  async #bounded(): Promise<string> {
    const text = await this.#read();
    boundedInput(text);
    return text;
  }
}

/**
 * Ввод клиента по его stdin.
 *
 * @param facts чем клиент снимает свой контекст
 */
export function clientInput(facts: CallerFacts): ClientInput {
  if (facts.stdinIsTerminal()) return TERMINAL_INPUT;
  return new PipedInput(() => facts.stdin());
}
