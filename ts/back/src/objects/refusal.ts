import type { Remedy } from "./protocol.ts";
import { NO_REMEDY } from "./remedy.ts";

/** Необязательное у отказа: причина и подсказка, как надо. */
export interface RefusalOptions extends ErrorOptions {
  /** Подсказка по адресу приёмника; нет — подсказать нечего. */
  readonly remedy?: Remedy;
}

/**
 * Объект отказывает ответить. Текст — без пути: путь до приёмника знает
 * только исполнитель цепочки, он и допишет его спереди, а за текстом —
 * подсказку по этому адресу.
 */
export class Refusal extends Error {
  override name = "Refusal";
  readonly remedy: Remedy;

  constructor(message: string, options: RefusalOptions = {}) {
    super(message, options);
    this.remedy = options.remedy ?? NO_REMEDY;
  }
}

/** Строка не исполнилась: итоговый текст отказа для вызывающего. */
export class Rejection extends Error {
  override name = "Rejection";
}
