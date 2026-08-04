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
 * Сообщение об ошибке для человека и агента:
 * `mpu <команда>: <причина>[; попробуй: <подсказка>]`. Префикс — первый
 * сегмент пути, а не весь путь: он называет команду, с которой
 * разговаривает пользователь (контракт спек команд). Формат общий для
 * обеих точек входа: в CLI строка уходит в stderr, в MCP — текстом
 * содержимого результата с признаком ошибки.
 */
export function formatCommandError(
  path: readonly string[],
  err: UsageError | DomainError,
): string {
  const hint = err.hint === undefined ? "" : `; попробуй: ${err.hint}`;
  return `mpu ${path[0]}: ${err.message}${hint}`;
}

/**
 * Файл не найден при чтении через io: реализация io переводит ошибку
 * файловой системы в этот класс, чтобы команда различала «нет файла» и
 * прочие сбои без привязки к рантайму.
 */
export class NotFoundIoError extends Error {
  override name = "NotFoundIoError";
}
