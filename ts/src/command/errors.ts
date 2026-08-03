/**
 * Два класса ошибок контракта команды. Различаются типом, а не текстом
 * (`platform/command-contract.md`): отображение в exit-коды и коды HTTP —
 * забота точки входа, команда только называет класс.
 */

/** Ошибка ввода: аргументы не удовлетворяют схеме. */
export class UsageError extends Error {
  override name = "UsageError";
  /** Текст после «; попробуй:» в stderr; отсутствует — подсказки нет. */
  readonly hint?: string;

  constructor(message: string, opts?: { hint?: string; cause?: unknown }) {
    super(message, { cause: opts?.cause });
    this.hint = opts?.hint;
  }
}

/** Доменная ошибка: вход корректен, выполнить не удалось. */
export class DomainError extends Error {
  override name = "DomainError";
  /** Текст после «; попробуй:» в stderr; отсутствует — подсказки нет. */
  readonly hint?: string;

  constructor(message: string, opts?: { hint?: string; cause?: unknown }) {
    super(message, { cause: opts?.cause });
    this.hint = opts?.hint;
  }
}

/**
 * Файл не найден при чтении через io: реализация io переводит ошибку
 * файловой системы в этот класс, чтобы команда различала «нет файла» и
 * прочие сбои без привязки к рантайму.
 */
export class NotFoundIoError extends Error {
  override name = "NotFoundIoError";
}
