/**
 * Ошибка резолва селектора (`docs/specs/platform/selector.md`).
 * Отдельный файл, а не сосед резолва: ошибку бросает и чтение кэша
 * (`cache.ts`), которое сам резолв импортирует, — иначе получился бы цикл.
 */

import { UsageError } from "../command/mod.ts";
import type { Candidate } from "./candidate.ts";

/**
 * Один класс на все подтипы отказа: спека даёт им общий код выхода (2) и
 * различает их только текстом для человека. Наследование от `UsageError`
 * и есть этот код — точка входа отображает в него класс ошибки, а не
 * разбирает сообщение.
 *
 * Кандидаты приложены к ошибке: команда печатает их следом за строкой
 * ошибки (спека, «Ввод/вывод»), а не собирает второй раз сама.
 */
export class SelectorError extends UsageError {
  override name = "SelectorError";
  readonly candidates: readonly Candidate[];

  constructor(
    message: string,
    opts: { candidates?: readonly Candidate[]; hint?: string } = {},
  ) {
    super(message, { hint: opts.hint });
    this.candidates = opts.candidates ?? [];
  }
}
